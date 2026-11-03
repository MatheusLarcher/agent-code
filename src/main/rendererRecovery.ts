// A tela vazia: o processo do renderer da janela principal morre (o Windows sem
// memória virtual derruba o que pedir memória naquela hora; o Chromium também
// mata o renderer que trava) e a janela ficava só com a cor de fundo, para
// sempre — nada recarregava a tela e o X esperava a resposta de um renderer que
// não existia mais. Aqui: a tela volta sozinha (espera crescente, para não
// martelar uma máquina ainda sem memória), o fechamento deixa de esperar quem
// morreu ou travou, e o motivo fica em <userData>/logs/tela.log.
//
// Regras do log: nunca lança, não bloqueia o main (escrita em fila) e só grava
// os campos de `ScreenLogEntry`. Sem `initScreenLog` (testes), é no-op.
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { freemem } from 'node:os'
import { join } from 'node:path'

/** Espera antes de cada recarga, pela quantidade de quedas recentes. */
export const RELOAD_DELAYS_MS = [1_000, 5_000, 30_000, 60_000] as const
/** Quedas mais antigas que isto não contam para a espera da próxima recarga. */
export const STABLE_AFTER_MS = 5 * 60_000
export const SCREEN_LOG_MAX_BYTES = 1024 * 1024

export type ScreenLogEvent =
  | 'renderer-gone'
  | 'renderer-reload'
  | 'renderer-recovered'
  | 'renderer-unresponsive'
  | 'renderer-responsive'
  | 'process-gone'

export interface ScreenLogEntry {
  event: ScreenLogEvent
  reason?: string
  exitCode?: number
  /** Tipo do processo filho (GPU, Utility…) no `process-gone`. */
  type?: string
  name?: string
  attempt?: number
  delayMs?: number
  freeMemMb?: number
}

export interface GoneDetails {
  reason: string
  exitCode: number
}

/** O mínimo da BrowserWindow que a recuperação usa (testável sem Electron). */
export interface RecoverableWindow {
  isDestroyed(): boolean
  on(event: 'unresponsive' | 'responsive', listener: () => void): unknown
  webContents: {
    isDestroyed(): boolean
    on(event: 'render-process-gone', listener: (event: unknown, details: GoneDetails) => void): unknown
    on(event: 'did-finish-load', listener: () => void): unknown
    reload(): void
  }
}

export interface RendererRecoveryOptions {
  /** A janela está fechando (X, quit, troca de banco): não recarrega. */
  isClosing: () => boolean
  /** A tela caiu (morreu ou travou) com o fechamento já pedido: conclua sem ela. */
  onDownWhileClosing?: () => void
  log?: (entry: ScreenLogEntry) => void
  now?: () => number
  freeMemoryMb?: () => number
}

export interface RendererRecovery {
  /** A tela não responde: morreu e ainda não voltou, ou está travada. */
  isDown(): boolean
  dispose(): void
}

const freeMemoryMb = (): number => Math.round(freemem() / (1024 * 1024))

export function watchRendererRecovery(win: RecoverableWindow, options: RendererRecoveryOptions): RendererRecovery {
  const log = options.log ?? logScreen
  const now = options.now ?? Date.now
  const memory = options.freeMemoryMb ?? freeMemoryMb
  let gone = false
  let hung = false
  let disposed = false
  let attempt = 0
  let crashes: number[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const alive = (): boolean => !disposed && !win.isDestroyed() && !win.webContents.isDestroyed()
  const downWhileClosing = (): void => {
    if (options.isClosing()) options.onDownWhileClosing?.()
  }

  const reload = (): void => {
    timer = null
    if (!alive() || !gone || options.isClosing()) return
    try {
      win.webContents.reload()
    } catch {
      // Janela destruída entre a checagem e a chamada: nada a recarregar.
    }
  }

  win.webContents.on('render-process-gone', (_event, details) => {
    if (disposed) return
    gone = true
    hung = false
    const at = now()
    crashes = crashes.filter((when) => at - when < STABLE_AFTER_MS)
    crashes.push(at)
    log({ event: 'renderer-gone', reason: details?.reason, exitCode: details?.exitCode, freeMemMb: memory() })
    if (options.isClosing()) return downWhileClosing()
    if (timer) return
    attempt += 1
    const delayMs = RELOAD_DELAYS_MS[Math.min(crashes.length, RELOAD_DELAYS_MS.length) - 1]
    log({ event: 'renderer-reload', attempt, delayMs })
    timer = setTimeout(reload, delayMs)
    timer.unref?.()
  })

  win.webContents.on('did-finish-load', () => {
    if (disposed) return
    if (gone && attempt > 0) log({ event: 'renderer-recovered', attempt, freeMemMb: memory() })
    gone = false
    hung = false
  })

  win.on('unresponsive', () => {
    if (disposed) return
    hung = true
    log({ event: 'renderer-unresponsive', freeMemMb: memory() })
    downWhileClosing()
  })

  win.on('responsive', () => {
    if (disposed || !hung) return
    hung = false
    log({ event: 'renderer-responsive' })
  })

  return {
    isDown: () => !disposed && (gone || hung),
    dispose: () => {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

/** Queda de processo filho do app (GPU, utilitário…): só registra. */
export function logChildProcessGone(details: { type: string; reason: string; exitCode: number; name?: string }): void {
  if (details.reason === 'clean-exit') return
  logScreen({
    event: 'process-gone',
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name,
    freeMemMb: freeMemoryMb()
  })
}

const STRING_KEYS = ['reason', 'type', 'name'] as const
const NUMBER_KEYS = ['exitCode', 'attempt', 'delayMs', 'freeMemMb'] as const

/** Só os campos conhecidos, com o tipo certo e tamanho limitado. */
export function sanitizeScreenLogEntry(entry: ScreenLogEntry): Record<string, unknown> {
  const raw = entry as unknown as Record<string, unknown>
  const out: Record<string, unknown> = { event: String(raw.event).slice(0, 40) }
  for (const key of STRING_KEYS) if (typeof raw[key] === 'string') out[key] = (raw[key] as string).slice(0, 80)
  for (const key of NUMBER_KEYS) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = Math.round(value)
  }
  return out
}

let target: { dir: string; file: string; rotated: string; maxBytes: number } | null = null
let queue: Promise<void> = Promise.resolve()
let warned = false

/** Liga o log em `<userDataDir>/logs/tela.log`. Chamado uma vez no boot. */
export function initScreenLog(userDataDir: string, options: { maxBytes?: number } = {}): void {
  const dir = join(userDataDir, 'logs')
  target = {
    dir,
    file: join(dir, 'tela.log'),
    rotated: join(dir, 'tela.1.log'),
    maxBytes: options.maxBytes ?? SCREEN_LOG_MAX_BYTES
  }
}

async function write(to: NonNullable<typeof target>, line: string): Promise<void> {
  await mkdir(to.dir, { recursive: true })
  const size = await stat(to.file).then((info) => info.size, () => 0)
  if (size > 0 && size + Buffer.byteLength(line) > to.maxBytes) await rename(to.file, to.rotated)
  await appendFile(to.file, line, 'utf8')
}

/** Registra um evento da tela. Nunca lança; a escrita acontece em fila. */
export function logScreen(entry: ScreenLogEntry): void {
  const to = target
  if (!to) return
  try {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...sanitizeScreenLogEntry(entry) })}\n`
    queue = queue.then(() => write(to, line)).catch((error: unknown) => {
      if (warned) return
      warned = true
      console.warn('[tela-log] falha ao gravar (as próximas falhas ficam caladas):', error)
    })
  } catch {
    /* nunca lança */
  }
}

/** Espera as escritas em fila (testes e encerramento). */
export function flushScreenLog(): Promise<void> {
  return queue
}
