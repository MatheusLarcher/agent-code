import { existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CentralRouteResult } from '../../shared/central'
import { Channels } from '../../shared/ipc'
import { askTypeSafe, typeSafeConfigured } from '../typesafe/client'
import { decideRoute, fallbackRoute, type AskFn } from './centralDecider'
import type { CentralIndex } from './centralIndex'
import {
  createCentralIndexStore,
  type CentralChangeHandler,
  type CentralChangeLike,
  type CentralIndexStore,
  type CentralIndexStoreDeps
} from './centralIndexStore'
import { parseCorrection, parseRouteRequest } from './centralSchemas'

/**
 * Handlers central:* do processo main. O index.ts só chama registerCentralIpc
 * com o ipcMain.handle e o repositório; a decisão mora em centralDecider.ts.
 *
 * - central:route: valida (inválido rejeita), e devolve o destino ou "Para onde
 *   vai?". Nunca rejeita por falha do TypeSafe ou do índice.
 * - central:correction: o "não era aqui" vira uma linha JSON no log local de
 *   correções (calibração). Erro de disco vai ao log e não rejeita.
 *
 * O índice da Etapa 2 é criado aqui, uma vez (no 1º uso), e aquecido em segundo
 * plano (`prewarm`). A rota espera por ele no máximo ~1 s: passou disso, segue com
 * o último índice que carregou (a carga continua para a próxima mensagem).
 */

export type CentralIpcListener = (event: unknown, ...args: unknown[]) => unknown

export interface CentralIpcDeps {
  /** Mesmo formato de ipcMain.handle. */
  handle: (channel: string, listener: CentralIpcListener) => void
  /** As conversas para o índice: `storageLifecycle.repository().loadConversations(query)`. */
  load: CentralIndexStoreDeps['load']
  /** O feed de mudanças: `storageLifecycle.subscribeChanges(handler)`. */
  subscribe?: CentralIndexStoreDeps['subscribe']
  /** A raiz do sandbox (lida uma vez, ao criar o índice). */
  sandboxRoot: () => string
  /** A pasta é do sandbox? */
  isSandbox: (cwd: string) => boolean
  /** `<pasta local do app>/central/corrections.jsonl`. */
  correctionsFile: () => string
  /** Para os testes. Padrão: askTypeSafe / typeSafeConfigured / fs.existsSync / 1 s. */
  ask?: AskFn
  configured?: () => Promise<boolean>
  exists?: (path: string) => boolean
  indexDeadlineMs?: number
}

export interface CentralIpcHandle {
  /** Carrega o índice em segundo plano depois de `delayMs` (uma vez; só com o TypeSafe ligado). */
  prewarm(delayMs?: number): void
  dispose(): void
}

/** Quanto a rota espera pelo índice: o roteamento não pode somar mais que ~1 s ao tempo do TypeSafe. */
export const CENTRAL_INDEX_DEADLINE_MS = 1_000
/** Atraso do aquecimento depois que o armazenamento fica pronto: fora do caminho da abertura. */
export const CENTRAL_PREWARM_DELAY_MS = 5_000
/** A Central muda a cada mensagem e nunca é destino: os avisos dela não recarregam o índice. */
const CENTRAL_ID = 'central'

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function withoutCentral(change: CentralChangeLike | readonly CentralChangeLike[]): CentralChangeLike[] {
  const list: readonly CentralChangeLike[] = Array.isArray(change) ? change : [change as CentralChangeLike]
  return list.filter((item) => item?.entityId !== CENTRAL_ID)
}

export function registerCentralIpc(deps: CentralIpcDeps): CentralIpcHandle {
  // Os padrões e a raiz do sandbox são lidos no USO, não aqui: registrar não toca no cliente do
  // TypeSafe nem na pasta do app (os testes do index.ts registram tudo com esses módulos de mentira).
  const ask: AskFn = deps.ask ?? ((request) => askTypeSafe(request))
  const configured = deps.configured ?? (() => typeSafeConfigured())
  const exists = deps.exists ?? existsSync
  const deadline = deps.indexDeadlineMs ?? CENTRAL_INDEX_DEADLINE_MS
  const env = { exists, isSandbox: deps.isSandbox }
  let store: CentralIndexStore | null = null
  let disposed = false
  /** O último índice que carregou: serve quando a carga atual demora ou falha. */
  let lastIndex: CentralIndex | null = null
  let prewarmTimer: ReturnType<typeof setTimeout> | null = null
  /** As linhas do log entram uma de cada vez. */
  let writing: Promise<void> = Promise.resolve()

  /** O índice da Etapa 2, criado no 1º uso e uma vez só (assina o feed a partir daí). */
  function indexStore(): CentralIndexStore {
    if (store) return store
    const subscribe = deps.subscribe
    store = createCentralIndexStore({
      load: deps.load,
      subscribe: subscribe ? (handler: CentralChangeHandler) => subscribe((change) => handler(withoutCentral(change))) : undefined,
      exists,
      sandboxRoot: deps.sandboxRoot(),
      isSandbox: deps.isSandbox
    })
    return store
  }

  function loadIndex(): Promise<CentralIndex | null> {
    if (disposed) return Promise.resolve(null)
    let pending: Promise<CentralIndex>
    try {
      pending = indexStore().getIndex()
    } catch (error) {
      console.error(`[central] índice indisponível: ${errorMessage(error)}`)
      return Promise.resolve(null)
    }
    return pending.then(
      (index) => (lastIndex = index),
      () => null
    )
  }

  /** O índice em até `deadline` ms; demorou ou falhou = o último que carregou (null se nunca carregou). */
  async function indexWithinDeadline(): Promise<CentralIndex | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deadline)
    })
    try {
      return (await Promise.race([loadIndex(), late])) ?? lastIndex
    } finally {
      clearTimeout(timer)
    }
  }

  async function typeSafeOn(): Promise<boolean> {
    try {
      return await configured()
    } catch {
      return false
    }
  }

  deps.handle(Channels.centralRoute, async (_event, payload): Promise<CentralRouteResult> => {
    const req = parseRouteRequest(payload)
    try {
      if (!(await typeSafeOn())) return fallbackRoute(req, lastIndex, env)
      return await decideRoute(req, await indexWithinDeadline(), { ...env, ask })
    } catch (error) {
      // Só a mensagem: o pedido carrega o texto do usuário.
      console.error(`[central] rota descartada: ${errorMessage(error)}`)
      return fallbackRoute(req, lastIndex, env)
    }
  })

  deps.handle(Channels.centralCorrection, async (_event, payload): Promise<void> => {
    const line = `${JSON.stringify(parseCorrection(payload))}\n`
    const write = writing.then(async () => {
      const file = deps.correctionsFile()
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, line, 'utf8')
    })
    writing = write.catch(() => undefined)
    try {
      await write
    } catch (error) {
      console.error(`[central] correção não gravada: ${errorMessage(error)}`)
    }
  })

  return {
    prewarm(delayMs = CENTRAL_PREWARM_DELAY_MS) {
      if (prewarmTimer) return
      prewarmTimer = setTimeout(() => {
        void typeSafeOn().then((on) => (on ? loadIndex() : null))
      }, delayMs)
      prewarmTimer.unref?.()
    },
    dispose() {
      disposed = true
      if (prewarmTimer) clearTimeout(prewarmTimer)
      store?.dispose()
    }
  }
}
