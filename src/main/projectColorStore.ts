/**
 * A cor do projeto FIXA: gravada no KV global da persistência (vale entre PCs
 * com PostgreSQL), pela identidade do projeto (remote git / commit raiz —
 * projectIdentity.ts), junto da origem e do arquivo.
 *
 * - Detecta só quando não há cor gravada.
 * - Única exceção: cor de `reserva` é trocada UMA vez quando o projeto ganha
 *   logo/tema (marcado em `replacedReserve`); depois nunca muda.
 * - Sandbox (todas as pastas de sandbox) = cor constante, sem KV.
 * - Persistência indisponível: devolve a detectada sem gravar (tenta gravar de
 *   novo no próximo pedido, sem varrer o disco outra vez).
 */
import { createHash } from 'node:crypto'
import { posix, resolve, win32 } from 'node:path'
import {
  SANDBOX_PROJECT_COLOR,
  isProjectColor,
  reserveProjectColor,
  type ProjectColor,
  type ProjectColorMap
} from '../shared/projectColor'
import type { KvAddress, KvWrite, VersionedKv } from './persistence/types'

/** Prefixo da chave no KV global: `agentcode.project-color.v1:<projectId>`. */
export const PROJECT_COLOR_KV_PREFIX = 'agentcode.project-color.v1:'

/** O que fica gravado no KV (JSON). */
export interface StoredProjectColor extends ProjectColor {
  /** A cor de reserva já foi trocada pela detectada (a troca única). */
  replacedReserve?: true
  /** Quando foi fixada (ISO). */
  at: string
}

/** O pedaço do repositório que a fixação usa (o teste passa um falso). */
export interface ProjectColorKv {
  getKv(address: KvAddress): Promise<VersionedKv | null>
  setKv(write: KvWrite): Promise<VersionedKv>
}

export interface ProjectColorDeps {
  /** O repositório ATIVO; null ou exceção = persistência indisponível. */
  repository: () => ProjectColorKv | null
  /** O `projectId` da identidade do projeto (pode lançar: pasta sem identidade). */
  projectId: (cwd: string) => Promise<string>
  /** A detecção pelas fontes; null = nenhuma cor aceitável. */
  detect: (cwd: string) => Promise<ProjectColor | null>
  /** Pasta de sandbox (todas são um projeto só). */
  isSandbox: (cwd: string) => boolean
  now?: () => Date
}

export interface ProjectColorService {
  /** As cores dos `cwds` (detecta/fixa as que faltam). Nunca lança por cwd. */
  colorsFor(cwds: readonly string[]): Promise<ProjectColorMap>
  /** Só o que já está resolvido (síncrono, para o `/api/state`); dispara o que falta. */
  peek(cwds: readonly string[]): ProjectColorMap
}

/** Quantos projetos são resolvidos ao mesmo tempo (git + varredura de disco). */
const CONCURRENCY = 2

function parseStored(value: string | undefined): StoredProjectColor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return isProjectColor(parsed) ? (parsed as StoredProjectColor) : null
  } catch {
    return null
  }
}

const publicColor = (c: ProjectColor): ProjectColor => ({
  hex: c.hex,
  source: c.source,
  ...(c.file ? { file: c.file } : {})
})

/** Chave pelo caminho quando a pasta não tem identidade (resolveProjectIdentity lançou). */
function pathKey(cwd: string): string {
  const folded = process.platform === 'win32' ? resolve(cwd).toLowerCase() : resolve(cwd)
  return `path:${createHash('sha256').update(folded).digest('hex').slice(0, 32)}`
}

const isRevisionConflict = (cause: unknown): boolean =>
  typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'REVISION_CONFLICT'

export function createProjectColorService(deps: ProjectColorDeps): ProjectColorService {
  const now = deps.now ?? ((): Date => new Date())
  /** Resultado final da sessão (gravado ou lido do KV). */
  const settled = new Map<string, Promise<ProjectColor>>()
  /** Última cor conhecida por cwd (para o `peek`). */
  const known = new Map<string, ProjectColor>()
  /** Uma varredura de disco por cwd por sessão. */
  const detections = new Map<string, Promise<ProjectColor | null>>()
  let running = 0
  const waiting: Array<() => void> = []

  async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (running >= CONCURRENCY) await new Promise<void>((go) => waiting.push(go))
    running++
    try {
      return await task()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  const detectOnce = (cwd: string): Promise<ProjectColor | null> => {
    let pending = detections.get(cwd)
    if (!pending) {
      pending = deps.detect(cwd).catch(() => null)
      detections.set(cwd, pending)
    }
    return pending
  }

  function repo(): ProjectColorKv | null {
    try {
      return deps.repository()
    } catch {
      return null
    }
  }

  async function write(kv: ProjectColorKv, key: string, color: StoredProjectColor, revision: number): Promise<ProjectColor> {
    try {
      await kv.setKv({ scope: 'global', key, value: JSON.stringify(color), expectedRevision: revision })
      return publicColor(color)
    } catch (cause) {
      if (!isRevisionConflict(cause)) throw cause
      // Outro PC fixou primeiro: vale a dele.
      const winner = parseStored((await kv.getKv({ scope: 'global', key }))?.value)
      if (winner) return publicColor(winner)
      throw cause
    }
  }

  /** Resolve um cwd. `persisted` = o KV respondeu (o resultado pode ficar para a sessão). */
  async function resolveOne(cwd: string): Promise<{ color: ProjectColor; persisted: boolean }> {
    if (deps.isSandbox(cwd)) return { color: SANDBOX_PROJECT_COLOR, persisted: true }
    let id: string
    try {
      id = await deps.projectId(cwd)
    } catch {
      id = pathKey(cwd)
    }
    const key = `${PROJECT_COLOR_KV_PREFIX}${id}`
    const reserve: ProjectColor = { hex: reserveProjectColor(id), source: 'reserva' }

    const kv = repo()
    let current: VersionedKv | null = null
    if (kv) {
      try {
        current = await kv.getKv({ scope: 'global', key })
      } catch {
        const detected = await detectOnce(cwd)
        return { color: detected ?? reserve, persisted: false }
      }
    }
    const stored = parseStored(current?.value)
    if (stored && stored.source !== 'reserva') return { color: publicColor(stored), persisted: true }

    const detected = await detectOnce(cwd)
    if (stored) {
      // A troca única: reserva → logo/tema, se agora houver.
      if (!detected || !kv || !current) return { color: publicColor(stored), persisted: true }
      // (`stored` existe ⇒ `kv` e `current` também; a guarda é só para o tipo.)
      const next: StoredProjectColor = { ...detected, replacedReserve: true, at: now().toISOString() }
      try {
        return { color: await write(kv, key, next, current.revision), persisted: true }
      } catch {
        return { color: publicColor(stored), persisted: false }
      }
    }
    const color = detected ?? reserve
    if (!kv) return { color, persisted: false }
    try {
      // Revisão 0 = só grava se ainda não houver (outro PC pode ter fixado agora).
      return { color: await write(kv, key, { ...color, at: now().toISOString() }, 0), persisted: true }
    } catch {
      return { color, persisted: false }
    }
  }

  function colorOf(cwd: string): Promise<ProjectColor> {
    const done = settled.get(cwd)
    if (done) return done
    const pending = limited(() => resolveOne(cwd)).then(
      ({ color, persisted }) => {
        known.set(cwd, color)
        // Sem KV, não fica para a sessão: o próximo pedido tenta gravar de novo.
        if (!persisted && settled.get(cwd) === pending) settled.delete(cwd)
        return color
      },
      (): ProjectColor => {
        settled.delete(cwd)
        return { hex: reserveProjectColor(pathKey(cwd)), source: 'reserva' }
      }
    )
    settled.set(cwd, pending)
    return pending
  }

  return {
    async colorsFor(cwds) {
      const entries = await Promise.all(cwds.map(async (cwd) => [cwd, await colorOf(cwd)] as const))
      return Object.fromEntries(entries)
    },
    peek(cwds) {
      const out: ProjectColorMap = {}
      for (const cwd of cwds) {
        const color = known.get(cwd)
        if (color) out[cwd] = color
        else if (!settled.has(cwd)) void colorOf(cwd)
      }
      return out
    }
  }
}

/** Teto de cwds por pedido do renderer. */
export const MAX_PROJECT_COLOR_CWDS = 200
const MAX_PATH_LENGTH = 1024

/**
 * Valida a entrada do IPC (borda): array de strings não vazias, absolutas, sem
 * NUL, até MAX_PROJECT_COLOR_CWDS. Devolve sem repetidos, ou lança TypeError.
 */
export function parseProjectColorCwds(input: unknown): string[] {
  if (!Array.isArray(input)) throw new TypeError('projectColors: esperado um array de caminhos.')
  if (input.length > MAX_PROJECT_COLOR_CWDS) {
    throw new TypeError(`projectColors: no máximo ${MAX_PROJECT_COLOR_CWDS} caminhos por pedido.`)
  }
  const out = new Set<string>()
  for (const item of input) {
    if (
      typeof item !== 'string' ||
      !item ||
      item.length > MAX_PATH_LENGTH ||
      item.includes('\0') ||
      !(win32.isAbsolute(item) || posix.isAbsolute(item))
    ) {
      throw new TypeError('projectColors: cada item precisa ser um caminho absoluto.')
    }
    out.add(item)
  }
  return [...out]
}
