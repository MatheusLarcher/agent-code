import { existsSync } from 'node:fs'
import {
  buildCentralIndex,
  summarizeConversation,
  type CentralConversationSummary,
  type CentralIndex,
  type VersionedConversationLike
} from './centralIndex'

export type { VersionedConversationLike }

/**
 * Cache do índice da Central: carrega as conversas UMA vez, guarda só os
 * resumos (nunca o payload) e se atualiza pelo feed de mudanças do repositório,
 * recarregando apenas as conversas que mudaram. Quem consome (o decisor, na
 * Etapa 3) liga `load` e `subscribe` ao repositório de verdade:
 *
 *   load:      (query) => repository.loadConversations(query)
 *   subscribe: (handler) => storageLifecycle.subscribeChanges(handler)
 *
 * Sem import estático de ../sandbox: ele puxa o electron (via ./store). A raiz e o
 * predicado do sandbox vêm de `deps` ou, na falta deles, de um `import()` feito na
 * 1ª carga; com os dois injetados a loja roda fora do Electron (calibração, testes).
 */

/** O que o índice pede ao carregador; cabe em `ConversationQuery` (persistence/types.ts), então `loadConversations` serve direto. */
export interface CentralLoadQuery {
  ids?: string[]
  /** Só a carga completa manda (`false`). A por ids confia no padrão do repositório (só as vivas) e descarta o que voltar com `deletedAt`. */
  includeDeleted?: boolean
}

/** O que o índice lê de uma mudança do feed (`RepositoryChange` cabe aqui). */
export interface CentralChangeLike {
  entity: string
  entityId: string
}

/** O feed real (`RepositoryChangeHandler`) entrega um LOTE de mudanças por vez; uma mudança solta também vale. */
export type CentralChangeHandler = (change: CentralChangeLike | readonly CentralChangeLike[]) => void

export interface CentralIndexStoreDeps {
  /** `{ includeDeleted: false }`: todas as conversas vivas. `{ ids }`: só essas (as apagadas ou ausentes não voltam). */
  load(query?: CentralLoadQuery): Promise<VersionedConversationLike[]>
  /** Assina o feed de mudanças; devolve o cancelamento. Sem ele só a rede de segurança atualiza o cache. */
  subscribe?(handler: CentralChangeHandler): () => void
  /** A pasta existe nesta máquina? Padrão: `fs.existsSync`. */
  exists?(path: string): boolean
  /** A raiz do sandbox. Padrão: a do app (`sandboxRoot()` de ../sandbox). */
  sandboxRoot?: string
  /** Esta pasta é do sandbox? Padrão: `isInsideSandbox(raiz, pasta)` de ../sandbox. */
  isSandbox?(cwd: string): boolean
  now?(): number
}

export interface CentralIndexStore {
  /**
   * O índice atual; carrega na 1ª chamada, atualiza o que mudou e reusa o cache no resto.
   * Rejeita se falhar a carga que ela espera (a 1ª, a de um `invalidate()` geral, a dos ids
   * marcados). A recarga por idade corre em segundo plano: nunca atrasa nem rejeita a chamada.
   */
  getIndex(): Promise<CentralIndex>
  /** Marca uma conversa (ou, sem id, tudo) para ser relida na próxima chamada de `getIndex()`. */
  invalidate(convId?: string): void
  /** Cancela a assinatura e fecha a loja. */
  dispose(): void
}

/**
 * Cache mais velho que isto: recarga completa em segundo plano, com o cache servido
 * enquanto ela roda (o outro PC pode gravar sem o aviso chegar até aqui).
 */
export const CENTRAL_INDEX_MAX_AGE_MS = 10 * 60_000

/** Uma entrada do cache: o resumo (null = não é candidata, ou payload ruim) e a versão da linha que o gerou. */
interface Entry {
  version: string
  summary: CentralConversationSummary | null
}

/** A raiz do sandbox e o predicado "esta pasta é do sandbox?" em uso. */
interface SandboxInfo {
  root: string
  isSandbox(cwd: string): boolean
}

/**
 * O que identifica a versão de uma linha. Só o `updatedAt` do payload não basta:
 * renomear (e o título do LLM) não mexe nele, mas mexe na linha (revisão e data).
 * E a pasta é deste PC: no Postgres ela vem do estado do dispositivo, que muda sem
 * mexer na linha (projeto mapeado ou movido aqui).
 */
function versionOf(row: VersionedConversationLike): string {
  const payload = row.payload as { updatedAt?: unknown; cwd?: unknown } | null | undefined
  const payloadAt = typeof payload?.updatedAt === 'number' ? payload.updatedAt : null
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : ''
  return JSON.stringify([row.revision ?? null, row.updatedAt ?? null, payloadAt, cwd])
}

const isBatch = (change: CentralChangeLike | readonly CentralChangeLike[]): change is readonly CentralChangeLike[] =>
  Array.isArray(change)

const disposedError = (): Error => new Error('O índice da Central foi descartado.')

export function createCentralIndexStore(deps: CentralIndexStoreDeps): CentralIndexStore {
  const clock = (): number => (deps.now ? deps.now() : Date.now())
  const folderExists = (path: string): boolean => (deps.exists ? deps.exists(path) : existsSync(path))
  // Resolvido na 1ª carga (não na criação): uma falha vira rejeição de `getIndex()`, não "linhas ruins".
  let sandbox: SandboxInfo | null = null
  async function sandboxInfo(): Promise<SandboxInfo> {
    if (sandbox) return sandbox
    // ../sandbox puxa o electron: só é carregado quando falta a raiz ou o predicado.
    const app = deps.sandboxRoot !== undefined && deps.isSandbox ? null : await import('../sandbox')
    const root = deps.sandboxRoot ?? app!.sandboxRoot()
    sandbox = { root, isSandbox: (cwd) => (deps.isSandbox ? deps.isSandbox(cwd) : app!.isInsideSandbox(root, cwd)) }
    return sandbox
  }

  let cache = new Map<string, Entry>()
  let index: CentralIndex | null = null
  /** Quando a última carga COMPLETA bem-sucedida começou. */
  let loadedAt = 0
  /** Falta uma carga completa que quem chama espera: nunca houve uma, a última dessas falhou ou houve `invalidate()` geral. */
  let fullStale = true
  /** Ids que mudaram desde a última leitura. */
  let dirty = new Set<string>()
  /**
   * A carga em andamento — uma só por vez: uma parcial junto com a completa seria
   * sobrescrita pela leitura mais velha desta. `background` = a recarga por idade, que ninguém espera.
   */
  let inflight: { promise: Promise<CentralIndex>; background: boolean } | null = null
  let disposed = false

  const unsubscribe = deps.subscribe?.((change) => {
    if (disposed) return
    for (const item of isBatch(change) ? change : [change]) {
      if (item && item.entity === 'conversation' && typeof item.entityId === 'string' && item.entityId !== '') {
        dirty.add(item.entityId)
      }
    }
  })

  /** Resume a linha em `into`; a mesma versão reaproveita o resumo de `previous`. Linha ruim não lança. */
  function ingest(
    row: VersionedConversationLike,
    previous: Map<string, Entry>,
    into: Map<string, Entry>,
    isSandbox: (cwd: string) => boolean
  ): void {
    if (typeof row !== 'object' || row === null || typeof row.id !== 'string' || row.id === '') return
    if (row.deletedAt) return
    const version = versionOf(row)
    const known = previous.get(row.id)
    if (known && known.version === version) {
      into.set(row.id, known)
      return
    }
    let summary: CentralConversationSummary | null
    try {
      summary = summarizeConversation(row, isSandbox)
    } catch {
      // Um defeito de leitura numa linha só tira essa linha (e não se loga: o conteúdo é do usuário).
      summary = null
    }
    into.set(row.id, { version, summary })
  }

  function assertAlive(): void {
    if (disposed) throw disposedError()
  }

  /** Relê TODAS as conversas vivas. O que sinalizou até aqui entra nesta carga; o que chegar durante ela fica para a próxima. */
  async function reloadAll(startedAt: number, background: boolean): Promise<SandboxInfo> {
    dirty = new Set()
    fullStale = false
    try {
      // `load` é chamado já dentro de `getIndex()`; o sandbox só é preciso para resumir as linhas.
      const rows = await deps.load({ includeDeleted: false })
      const info = await sandboxInfo()
      assertAlive()
      const next = new Map<string, Entry>()
      for (const row of rows) ingest(row, cache, next, info.isSandbox)
      cache = next
      loadedAt = startedAt
      return info
    } catch (error) {
      // Nada foi aplicado: a próxima chamada refaz a carga completa (e com ela o que estava sinalizado).
      // A de segundo plano não remarca: a idade continua vencida e a próxima chamada dispara outra sem esperar.
      if (!background) fullStale = true
      throw error
    }
  }

  /** Relê só os ids marcados; os que voltam apagados ou ausentes saem do cache. */
  async function reloadDirty(): Promise<SandboxInfo> {
    const ids = [...dirty]
    dirty = new Set()
    try {
      const rows = await deps.load({ ids })
      const info = await sandboxInfo()
      assertAlive()
      const alive = new Set<string>()
      for (const row of rows) {
        ingest(row, cache, cache, info.isSandbox)
        if (typeof row?.id === 'string' && !row.deletedAt) alive.add(row.id)
      }
      for (const id of ids) if (!alive.has(id)) cache.delete(id)
      return info
    } catch (error) {
      for (const id of ids) dirty.add(id)
      throw error
    }
  }

  /** Monta o índice dos resumos em cache; a pasta é conferida a cada montagem. */
  function rebuild(info: SandboxInfo): CentralIndex {
    const summaries: CentralConversationSummary[] = []
    for (const entry of cache.values()) if (entry.summary) summaries.push(entry.summary)
    index = buildCentralIndex(summaries, { sandboxRoot: info.root, exists: folderExists })
    return index
  }

  /** Registra a carga como a única em andamento. A falha da de segundo plano é consumida aqui: só a mensagem vai ao log. */
  function start(load: Promise<SandboxInfo>, background: boolean): Promise<CentralIndex> {
    const current = { promise: load.then(rebuild), background }
    inflight = current
    const settled = (): void => {
      if (inflight === current) inflight = null
    }
    current.promise.then(settled, (error: unknown) => {
      settled()
      if (background && !disposed) {
        console.error(`[central] recarga do índice em segundo plano falhou: ${(error as Error)?.message ?? error}`)
      }
    })
    return current.promise
  }

  function getIndex(): Promise<CentralIndex> {
    if (disposed) return Promise.reject(disposedError())
    if (inflight) {
      // Chamadas simultâneas compartilham a carga que quem chama espera.
      if (!inflight.background) return inflight.promise
      // Durante a recarga em segundo plano o cache serve na hora. Um invalidate() geral feito depois
      // que ela começou não é coberto pela leitura dela: espera ela terminar e relê tudo.
      if (!fullStale && index) return Promise.resolve(index)
      const retry = (): Promise<CentralIndex> => getIndex()
      return inflight.promise.then(retry, retry)
    }
    const startedAt = clock()
    // 1ª carga, invalidate() geral ou falha da completa anterior: quem chama espera a leitura completa.
    if (fullStale || index === null) return start(reloadAll(startedAt, false), false)
    // Cache velho: devolve o que tem NA HORA e relê tudo em segundo plano (os ids marcados vão junto).
    if (startedAt - loadedAt >= CENTRAL_INDEX_MAX_AGE_MS) {
      void start(reloadAll(startedAt, true), true)
      return Promise.resolve(index)
    }
    if (dirty.size > 0) return start(reloadDirty(), false)
    return Promise.resolve(index)
  }

  function invalidate(convId?: string): void {
    if (disposed) return
    if (convId === undefined) fullStale = true
    else if (typeof convId === 'string' && convId !== '') dirty.add(convId)
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    unsubscribe?.()
    cache = new Map()
    index = null
    dirty = new Set()
  }

  return { getIndex, invalidate, dispose }
}
