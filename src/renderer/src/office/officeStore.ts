/**
 * Store externa do escritório, fora do React. O App.tsx publica o OfficeFeed
 * (referências ao próprio estado dele) e quem desenha assina — nenhum setState
 * por quadro, nenhum re-render do App por causa do escritório.
 *
 * `override` existe para o feed sintético de medição (só DEV): enquanto ligado,
 * o snapshot é ele, e o feed real continua guardado para quando desligar.
 *
 * A cor de cada projeto chega à parte (`setProjectColors`, de useProjectColors):
 * o snapshot real é o feed publicado com `projectColors` junto — a MESMA
 * referência enquanto nem o feed nem as cores mudam (useSyncExternalStore).
 * Feed que já traz `projectColors` (demo, testes) fica com as dele.
 */
import type { ProjectColorMap } from '@shared/projectColor'
import type { OfficeFeed } from './adapter/feed'

export type OfficeFeedListener = (feed: OfficeFeed) => void

const NO_COLORS: Readonly<ProjectColorMap> = Object.freeze({})

export class OfficeStore {
  private real: OfficeFeed | null = null
  private override: OfficeFeed | null = null
  private colors: Readonly<ProjectColorMap> | null = null
  private merged: { from: OfficeFeed; colors: Readonly<ProjectColorMap>; feed: OfficeFeed } | null = null
  private readonly subs = new Set<OfficeFeedListener>()
  private readonly colorSubs = new Set<() => void>()

  /** As cores dos projetos (por cwd), sem depender do feed: a Central e a lateral (useProjectColorMap). */
  readonly getProjectColors = (): Readonly<ProjectColorMap> => this.colors ?? NO_COLORS

  readonly subscribeProjectColors = (cb: () => void): (() => void) => {
    this.colorSubs.add(cb)
    return () => void this.colorSubs.delete(cb)
  }

  publish(feed: OfficeFeed): void {
    this.real = feed
    if (!this.override) this.emit()
  }

  /** As cores dos projetos (por cwd) que o PC já resolveu. */
  setProjectColors(colors: Readonly<ProjectColorMap>): void {
    if (colors === this.colors) return
    this.colors = colors
    for (const cb of [...this.colorSubs]) cb()
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
    return this.override ?? this.withColors(this.real)
  }

  subscribe(cb: OfficeFeedListener): () => void {
    this.subs.add(cb)
    return () => void this.subs.delete(cb)
  }

  private withColors(feed: OfficeFeed | null): OfficeFeed | null {
    const colors = this.colors
    if (!feed || !colors || feed.projectColors) return feed
    if (this.merged?.from !== feed || this.merged.colors !== colors) this.merged = { from: feed, colors, feed: { ...feed, projectColors: colors } }
    return this.merged.feed
  }

  private emit(): void {
    const snap = this.getSnapshot()
    if (!snap) return
    // Cópia: quem cancela dentro do callback não pula o seguinte.
    for (const cb of [...this.subs]) cb(snap)
  }
}

export const officeStore = new OfficeStore()
