import { watch as fsWatch, promises as fs } from 'node:fs'
import path from 'node:path'
import { planDirPath } from './planningStore'
import { isOwnWrite as defaultIsOwnWrite } from './planningWrites'

/**
 * Vigia dos planejamentos ABERTOS: avisa quando os arquivos de
 * docs/spec/<slug>/ mudam no disco por fora do app (editor, git, agente
 * rodando comando) para a tela recarregar.
 *
 * - Um fs.watch recursivo por planejamento, com contagem de referências.
 * - Rajadas (tmp + rename, vários arquivos de uma vez) viram UM evento depois
 *   de `debounceMs` de silêncio.
 * - _sandbox/**, _handoff/** e *.tmp nunca contam.
 * - Eco: arquivo cujo conteúdo é o que o próprio app gravou por último
 *   (planningWrites) não conta.
 * - Pasta inexistente ou erro do fs.watch não derruba nada: console.warn e o
 *   vigia daquele planejamento fica mudo.
 */

export interface PlanningChange {
  projectCwd: string
  slug: string
}

export interface WatchHandle {
  close(): void
}

/** Abre a vigia de `dir`. `onEvent` recebe o caminho relativo (ou null quando
 *  o SO não informa); `onError` recebe falhas assíncronas. Pode lançar. */
export type WatchFactory = (
  dir: string,
  onEvent: (relPath: string | null) => void,
  onError: (err: unknown) => void
) => WatchHandle

/** Leitura de um arquivo alterado: bytes, null se não existe, 'dir' se é pasta. */
export type ReadForEcho = (file: string) => Promise<Uint8Array | null | 'dir'>

export interface PlanningWatcherOptions {
  onChange: (change: PlanningChange) => void
  debounceMs?: number
  /** Teto de espera numa rajada contínua (o debounce não pode adiar para sempre). */
  maxWaitMs?: number
  watchFactory?: WatchFactory
  readFile?: ReadForEcho
  isOwnWrite?: (file: string, content: Uint8Array | null) => boolean
  warn?: (...args: unknown[]) => void
}

const IGNORED_DIRS = new Set(['_sandbox', '_handoff'])

/** Caminho relativo à pasta do planejamento que o vigia nunca considera. */
export function isIgnoredPlanPath(relPath: string): boolean {
  const parts = relPath.split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return false
  if (IGNORED_DIRS.has(parts[0])) return true
  return parts[parts.length - 1].toLowerCase().endsWith('.tmp')
}

export const defaultWatchFactory: WatchFactory = (dir, onEvent, onError) => {
  const watcher = fsWatch(dir, { recursive: true, persistent: false }, (_type, filename) => {
    onEvent(filename == null ? null : String(filename))
  })
  // Sem ouvinte de 'error', um EPERM (pasta apagada no Windows) vira exceção
  // não tratada no processo main.
  watcher.on('error', onError)
  return watcher
}

export const defaultReadForEcho: ReadForEcho = async (file) => {
  try {
    return await fs.readFile(file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    if (code === 'EISDIR') return 'dir'
    throw err
  }
}

interface Entry {
  projectCwd: string
  slug: string
  dir: string
  refs: number
  handle: WatchHandle | null
  closed: boolean
  pending: Set<string>
  /** Houve evento sem nome de arquivo: não dá para descartar como eco. */
  unknown: boolean
  timer: ReturnType<typeof setTimeout> | null
  firstEventAt: number
}

function keyOf(dir: string): string {
  return process.platform === 'win32' ? dir.toLowerCase() : dir
}

export class PlanningWatcher {
  private readonly entries = new Map<string, Entry>()
  private readonly debounceMs: number
  private readonly maxWaitMs: number
  private readonly watchFactory: WatchFactory
  private readonly readFile: ReadForEcho
  private readonly isOwnWrite: (file: string, content: Uint8Array | null) => boolean
  private readonly warn: (...args: unknown[]) => void

  constructor(private readonly opts: PlanningWatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 150
    this.maxWaitMs = opts.maxWaitMs ?? 1000
    this.watchFactory = opts.watchFactory ?? defaultWatchFactory
    this.readFile = opts.readFile ?? defaultReadForEcho
    this.isOwnWrite = opts.isOwnWrite ?? defaultIsOwnWrite
    this.warn = opts.warn ?? ((...args) => console.warn(...args))
  }

  /** Começa (ou reforça) a vigia do planejamento. Lança só para slug/cwd inválidos. */
  watch(projectCwd: string, slug: string): void {
    const dir = planDirPath(projectCwd, slug)
    const key = keyOf(dir)
    const existing = this.entries.get(key)
    if (existing) {
      existing.refs++
      // Vigia que caiu (pasta sumiu, erro do SO) tenta de novo a cada abertura.
      if (!existing.handle) this.open(existing)
      return
    }
    const entry: Entry = {
      projectCwd,
      slug,
      dir,
      refs: 1,
      handle: null,
      closed: false,
      pending: new Set(),
      unknown: false,
      timer: null,
      firstEventAt: 0
    }
    this.entries.set(key, entry)
    this.open(entry)
  }

  private open(entry: Entry): void {
    try {
      entry.handle = this.watchFactory(
        entry.dir,
        (rel) => this.onEvent(entry, rel),
        (err) => this.onError(entry, err)
      )
    } catch (err) {
      entry.handle = null
      this.warn(`[planning] não foi possível vigiar ${entry.dir}:`, err)
    }
  }

  /** Reabre a vigia que caiu, sem mexer na contagem (reabertura pela mesma tela). */
  revive(projectCwd: string, slug: string): void {
    const entry = this.entries.get(keyOf(planDirPath(projectCwd, slug)))
    if (entry && !entry.handle) this.open(entry)
  }

  /** Solta uma referência; na última, fecha o fs.watch. */
  unwatch(projectCwd: string, slug: string): void {
    const key = keyOf(planDirPath(projectCwd, slug))
    const entry = this.entries.get(key)
    if (!entry) return
    entry.refs--
    if (entry.refs > 0) return
    this.entries.delete(key)
    this.dispose(entry)
  }

  /** Fecha todas as vigias (encerramento do app). */
  closeAll(): void {
    for (const entry of this.entries.values()) this.dispose(entry)
    this.entries.clear()
  }

  /** Quantas vigias estão abertas (diagnóstico/teste). */
  get size(): number {
    return this.entries.size
  }

  private dispose(entry: Entry): void {
    entry.closed = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.pending.clear()
    try {
      entry.handle?.close()
    } catch {
      /* já fechado */
    }
    entry.handle = null
  }

  private onError(entry: Entry, err: unknown): void {
    if (entry.closed) return
    this.warn(`[planning] vigia de ${entry.dir} parou:`, err)
    try {
      entry.handle?.close()
    } catch {
      /* já fechado */
    }
    entry.handle = null
  }

  private onEvent(entry: Entry, rel: string | null): void {
    if (entry.closed) return
    if (rel === null) entry.unknown = true
    else if (isIgnoredPlanPath(rel)) return
    else entry.pending.add(rel)

    const now = Date.now()
    if (!entry.timer) entry.firstEventAt = now
    else clearTimeout(entry.timer)
    const waited = now - entry.firstEventAt
    const delay = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - waited))
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.flush(entry)
    }, delay)
  }

  private async flush(entry: Entry): Promise<void> {
    const rels = [...entry.pending]
    const unknown = entry.unknown
    entry.pending.clear()
    entry.unknown = false
    if (entry.closed) return
    let external = unknown
    for (const rel of rels) {
      if (external) break
      external = await this.isExternal(path.join(entry.dir, rel))
    }
    if (!external || entry.closed) return
    try {
      this.opts.onChange({ projectCwd: entry.projectCwd, slug: entry.slug })
    } catch (err) {
      this.warn('[planning] falha ao avisar mudança:', err)
    }
  }

  /** O arquivo mudou por fora do app? Na dúvida (erro de leitura), sim. */
  private async isExternal(file: string): Promise<boolean> {
    let content: Uint8Array | null | 'dir'
    try {
      content = await this.readFile(file)
    } catch {
      return true
    }
    // Evento da própria pasta (o Windows avisa 'cards' quando um filho muda):
    // o evento do arquivo em si é que decide.
    if (content === 'dir') return false
    return !this.isOwnWrite(file, content)
  }
}
