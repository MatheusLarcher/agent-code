/**
 * Store externa do escritório, fora do React. O App.tsx publica o OfficeFeed
 * (referências ao próprio estado dele) e quem desenha assina — nenhum setState
 * por quadro, nenhum re-render do App por causa do escritório.
 *
 * `override` existe para o feed sintético de medição (só DEV): enquanto ligado,
 * o snapshot é ele, e o feed real continua guardado para quando desligar.
 */
import type { OfficeFeed } from './adapter/feed'

export type OfficeFeedListener = (feed: OfficeFeed) => void

export class OfficeStore {
  private real: OfficeFeed | null = null
  private override: OfficeFeed | null = null
  private readonly subs = new Set<OfficeFeedListener>()

  publish(feed: OfficeFeed): void {
    this.real = feed
    if (!this.override) this.emit()
  }

  /** Feed sintético (DEV); null volta ao real. */
  setOverride(feed: OfficeFeed | null): void {
    this.override = feed
    this.emit()
  }

  get overridden(): boolean {
    return this.override !== null
  }

  getSnapshot(): OfficeFeed | null {
    return this.override ?? this.real
  }

  subscribe(cb: OfficeFeedListener): () => void {
    this.subs.add(cb)
    return () => void this.subs.delete(cb)
  }

  private emit(): void {
    const snap = this.getSnapshot()
    if (!snap) return
    // Cópia: quem cancela dentro do callback não pula o seguinte.
    for (const cb of [...this.subs]) cb(snap)
  }
}

export const officeStore = new OfficeStore()
