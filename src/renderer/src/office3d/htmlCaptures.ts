/**
 * As capturas do HTML do agente para a TV em 3D (o main tira a foto numa janela
 * escondida pelo protocolo agent-mockup; aqui só se pede e se guarda o bitmap).
 *
 *   want(write, cwd)  a TV quer mostrar esta escrita: pede a captura (uma por
 *                     escrita; o mesmo arquivo no máximo a cada RECAPTURE_MS);
 *   image(id)         o bitmap pronto, 'failed' (a TV mostra o esqueleto) ou null
 *                     (ainda não chegou);
 *   dispose()         fecha os bitmaps; captura que chegar depois é descartada.
 *
 * Só fica o bitmap da escrita que a TV quer agora (o anterior fecha na hora).
 */
import type { MockupCaptureResult, MockupRequest } from '@shared/officeMockup'
import type { HtmlWrite } from './agentHtml'

/** O mesmo arquivo não é recapturado mais que uma vez neste intervalo. */
export const RECAPTURE_MS = 4_000

export interface MockupApi {
  officeMockupCapture(req: MockupRequest): Promise<MockupCaptureResult>
}

/** A API do app (window.api); null fora do Electron (harness, testes). */
export function appMockupApi(): MockupApi | null {
  const api = (globalThis as { window?: { api?: Partial<MockupApi> } }).window?.api
  return api?.officeMockupCapture ? (api as MockupApi) : null
}

type Slot = { id: string; state: 'pending' } | { id: string; state: 'ok'; bitmap: ImageBitmap } | { id: string; state: 'failed' }

export class HtmlCaptures {
  private slot: Slot | null = null
  /** Arquivo → quando foi capturado por último (ms). */
  private readonly lastByPath = new Map<string, number>()
  private waiting: { write: HtmlWrite; cwd: string } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly api: MockupApi | null,
    /** Captura nova pronta (ou falhou): a TV redesenha. */
    private readonly onReady: () => void,
    private readonly clock: () => number = () => Date.now()
  ) {}

  /** A TV quer mostrar esta escrita. */
  want(write: HtmlWrite, cwd: string): void {
    if (this.disposed || this.slot?.id === write.id) return
    if (!this.api) {
      this.replace({ id: write.id, state: 'failed' })
      return
    }
    const last = this.lastByPath.get(write.path) ?? -Infinity
    const wait = last + RECAPTURE_MS - this.clock()
    if (wait > 0) {
      // Editou de novo logo depois: recaptura quando der (a última escrita manda).
      this.waiting = { write, cwd }
      if (!this.timer) this.timer = setTimeout(() => this.flushWaiting(), wait)
      return
    }
    this.start(write, cwd)
  }

  private flushWaiting(): void {
    this.timer = null
    const w = this.waiting
    this.waiting = null
    if (w && !this.disposed) this.start(w.write, w.cwd)
  }

  private start(write: HtmlWrite, cwd: string): void {
    this.lastByPath.set(write.path, this.clock())
    this.replace({ id: write.id, state: 'pending' })
    void this.api!.officeMockupCapture({ cwd, path: write.path })
      .then(async (res) => {
        if (this.disposed || this.slot?.id !== write.id) return
        if (!res.ok) return this.done({ id: write.id, state: 'failed' })
        const bitmap = await createImageBitmap(new Blob([res.png as BlobPart], { type: 'image/png' })).catch(() => null)
        if (this.disposed || this.slot?.id !== write.id) return bitmap?.close()
        this.done(bitmap ? { id: write.id, state: 'ok', bitmap } : { id: write.id, state: 'failed' })
      })
      .catch(() => {
        if (!this.disposed && this.slot?.id === write.id) this.done({ id: write.id, state: 'failed' })
      })
  }

  private done(slot: Slot): void {
    this.replace(slot)
    this.onReady()
  }

  private replace(slot: Slot | null): void {
    if (this.slot?.state === 'ok') this.slot.bitmap.close()
    this.slot = slot
  }

  /** O bitmap da escrita, 'failed' ou null (pendente / outra escrita). */
  image(id: string): ImageBitmap | 'failed' | null {
    const s = this.slot
    if (!s || s.id !== id) return null
    return s.state === 'ok' ? s.bitmap : s.state === 'failed' ? 'failed' : null
  }

  /** A TV deixou de mostrar HTML: o bitmap fecha. */
  clear(): void {
    this.replace(null)
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.waiting = null
    this.replace(null)
  }
}
