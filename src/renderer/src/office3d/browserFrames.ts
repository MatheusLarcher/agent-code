/**
 * Os quadros do navegador embutido para o projetor, sem mexer no main: ele só
 * manda o screencast da conversa ATIVA (window.api.onBrowserFrame — JPEG da
 * web ou PNG do Android, em base64, sem convId) e o estado dela
 * (onBrowserState: url e título). Cada quadro vale para a conversa que é a
 * ativa na hora em que chega.
 *
 * Guardamos o último quadro BRUTO de cada conversa (a string base64 — quem
 * mostra é que decodifica, e só o que está à vista), no máximo MAX_CONVS
 * conversas: a usada há mais tempo sai. `live` diz se ainda é ao vivo (a
 * conversa ativa, com quadro recente). `dispose` tira os dois ouvintes.
 */
import type { BrowserFrame, BrowserState } from '@shared/ipc'

/** O pedaço de window.api que o projetor usa (injetável nos testes). */
export interface BrowserFeedApi {
  onBrowserFrame(cb: (f: BrowserFrame) => void): () => void
  onBrowserState(cb: (s: BrowserState) => void): () => void
}

export interface RawFrame {
  data: string
  width: number
  height: number
  mime: string
  /** Quando chegou (ms). */
  at: number
}

/** Conversas com quadro guardado. */
export const MAX_CONVS = 8
/** Sem quadro novo há mais que isto, deixa de ser "ao vivo". */
export const LIVE_MS = 5_000
/** Largura máxima do bitmap decodificado (a textura tem 640; o telão, até isto). */
export const DECODE_MAX_W = 960

/** O window.api do app, se houver (testes e DEV sem preload: null). */
export function appBrowserApi(): BrowserFeedApi | null {
  const api = (globalThis as { window?: { api?: Partial<BrowserFeedApi> } }).window?.api
  return api?.onBrowserFrame && api.onBrowserState ? (api as BrowserFeedApi) : null
}

export class BrowserFrames {
  private readonly frames = new Map<string, RawFrame>()
  private readonly states = new Map<string, { url: string; title: string }>()
  private readonly offs: Array<() => void> = []

  constructor(
    api: BrowserFeedApi | null,
    /** A conversa ativa agora (a dona dos quadros que chegam); null ignora o quadro. */
    private readonly activeId: () => string | null,
    /** Quadro novo da conversa. */
    private readonly onFrame: (convId: string) => void,
    private readonly now: () => number = () => Date.now()
  ) {
    if (!api) return
    this.offs.push(api.onBrowserFrame((f) => this.takeFrame(f)))
    this.offs.push(api.onBrowserState((s) => this.takeState(s)))
  }

  private takeFrame(f: BrowserFrame): void {
    const id = this.activeId()
    if (!id || !f || typeof f.data !== 'string' || !f.data) return
    this.frames.delete(id)
    this.frames.set(id, { data: f.data, width: f.width, height: f.height, mime: f.mime ?? 'image/jpeg', at: this.now() })
    while (this.frames.size > MAX_CONVS) this.frames.delete(this.frames.keys().next().value as string)
    this.onFrame(id)
  }

  private takeState(s: BrowserState): void {
    const id = this.activeId()
    if (!id || !s) return
    this.states.delete(id)
    this.states.set(id, { url: s.url ?? '', title: s.title ?? '' })
    while (this.states.size > MAX_CONVS) this.states.delete(this.states.keys().next().value as string)
  }

  /** O último quadro da conversa (de quando ela era a ativa). */
  frame(convId: string): RawFrame | null {
    return this.frames.get(convId) ?? null
  }

  /** URL e título do navegador da conversa (do último estado dela como ativa). */
  state(convId: string): { url: string; title: string } | null {
    return this.states.get(convId) ?? null
  }

  /** Ao vivo: a conversa ativa, com quadro chegando. */
  live(convId: string): boolean {
    const f = this.frames.get(convId)
    return !!f && convId === this.activeId() && this.now() - f.at < LIVE_MS
  }

  /** Conversas com quadro guardado (testes). */
  get size(): number {
    return this.frames.size
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off()
    this.frames.clear()
    this.states.clear()
  }
}

/** base64 → bitmap (no máximo DECODE_MAX_W de largura); null sem suporte ou com imagem quebrada. */
export async function decodeFrame(f: RawFrame): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function' || typeof atob !== 'function') return null
  try {
    const bin = atob(f.data)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const blob = new Blob([bytes], { type: f.mime })
    if (f.width <= DECODE_MAX_W) return await createImageBitmap(blob)
    const k = DECODE_MAX_W / f.width
    return await createImageBitmap(blob, { resizeWidth: DECODE_MAX_W, resizeHeight: Math.max(1, Math.round(f.height * k)), resizeQuality: 'medium' })
  } catch {
    return null
  }
}
