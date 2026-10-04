/**
 * A captura do HTML do agente para a TV em 3D — a fila, sem Electron (a janela
 * escondida vem de fora: mockupElectron.ts).
 *
 * Uma captura por vez: carrega a URL do protocolo, espera o `did-finish-load`
 * (o load resolve) e uma pausa curta, e tira a foto; tudo com timeout. Timeout
 * ou erro destroem a janela (a próxima nasce limpa). A janela é reaproveitada
 * entre capturas e fecha sozinha depois de IDLE_MS sem uso (não fica viva à toa
 * nem segura o app aberto).
 */
import { MOCKUP_CAPTURE_TIMEOUT_MS } from '../../shared/officeMockup'

export interface CaptureWindow {
  /** Carrega e resolve no did-finish-load (rejeita se falhar). */
  load(url: string): Promise<void>
  /** A foto em PNG (vazia = falhou). */
  capture(): Promise<Uint8Array>
  destroy(): void
}

export type CaptureOutcome = { ok: true; png: Uint8Array } | { ok: false; error: string }

/** A pausa depois do load (fontes, animação de entrada, scripts do mockup). */
export const SETTLE_MS = 400
/** Sem captura por este tempo, a janela escondida fecha. */
export const IDLE_MS = 60_000

interface Options {
  timeoutMs?: number
  settleMs?: number
  idleMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class MockupCapturer {
  private win: CaptureWindow | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private idle: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly timeoutMs: number
  private readonly settleMs: number
  private readonly idleMs: number

  constructor(
    private readonly createWindow: () => CaptureWindow,
    opts: Options = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? MOCKUP_CAPTURE_TIMEOUT_MS
    this.settleMs = opts.settleMs ?? SETTLE_MS
    this.idleMs = opts.idleMs ?? IDLE_MS
  }

  /** Enfileira a captura da URL. */
  capture(url: string): Promise<CaptureOutcome> {
    const run = this.chain.then(() => this.run(url))
    this.chain = run.catch(() => undefined)
    return run
  }

  private async run(url: string): Promise<CaptureOutcome> {
    if (this.disposed) return { ok: false, error: 'fechado' }
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('tempo esgotado')), this.timeoutMs)
    })
    try {
      const win = (this.win ??= this.createWindow())
      const png = await Promise.race([
        (async () => {
          await win.load(url)
          await sleep(this.settleMs)
          return win.capture()
        })(),
        timeout
      ])
      if (!png.length) throw new Error('captura vazia')
      return { ok: true, png }
    } catch (err) {
      this.release()
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (timer) clearTimeout(timer)
      if (!this.disposed) this.idle = setTimeout(() => this.release(), this.idleMs)
    }
  }

  /** Fecha a janela agora (a próxima captura abre outra). */
  release(): void {
    const w = this.win
    this.win = null
    try {
      w?.destroy()
    } catch {
      /* já destruída */
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    this.release()
  }
}
