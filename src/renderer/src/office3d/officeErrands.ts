/**
 * As idas pelo escritório que o feed dispara (fora do turno de cada um):
 *   - o pulso de despacho da Central pelas trilhas (centralPulse.ts), com o
 *     gesto de enviar do agente dela;
 *   - a ida à estante de Memórias de quem consulta a memória (memoryTrips.ts):
 *     a turma recebe quem está na sequência (crowd.setShelfTrips) e o cérebro
 *     faz o resto (vai, folheia ou grava, e volta);
 *   - os papéis de memória na mesa de quem leu memórias (memoryPapers.ts).
 * A pasta de memórias vem do main (getCacheInfo) uma vez; se chega depois do
 * feed, os papéis são refeitos com o último feed e pede-se um quadro (`onDirty`).
 */
import type { Object3D } from 'three'
import { CENTRAL_ID } from '@shared/central'
import type { OfficeFeed } from '../office/adapter/feed'
import { principalKey } from '../office/adapter/model'
import { sendOff } from './brain'
import { CentralPulses } from './centralPulse'
import type { Crowd } from './crowd'
import type { RoomView } from './decor'
import { OFFICE_ID, type Office3DLayout } from './layout'
import { syncMemoryPapers } from './memoryPapers'
import { scanMemorySequences } from './memoryTrips'

/** A pasta de memórias (window.api.getCacheInfo); null fora do app. */
function appMemoriesDir(): Promise<string | null> {
  const api = (globalThis as { window?: { api?: { getCacheInfo?: () => Promise<{ memoriesDir?: string }> } } }).window?.api
  return api?.getCacheInfo ? api.getCacheInfo().then((i) => i.memoriesDir ?? null, () => null) : Promise.resolve(null)
}

export class OfficeErrands {
  readonly pulses: CentralPulses
  /** A pasta de memórias (Read/Grep/Glob nela é consulta). */
  memoriesDir: string | null = null
  /** O último feed (os papéis são refeitos com ele quando a pasta chega). */
  private last: { feed: OfficeFeed | null; layout: Office3DLayout; rooms: ReadonlyMap<string, RoomView> } | null = null
  private disposed = false

  constructor(
    parent: Object3D,
    private readonly crowd: Crowd,
    private readonly onDirty: () => void = () => {}
  ) {
    this.pulses = new CentralPulses(parent)
    this.pulses.onSend = () => {
      const b = crowd.brains.get(principalKey(CENTRAL_ID))
      if (b) sendOff(b)
    }
    void appMemoriesDir().then((d) => {
      this.memoriesDir = d
      if (!d || !this.last || this.disposed) return
      this.papers(this.last.feed, this.last.layout, this.last.rooms)
      this.onDirty()
    })
  }

  /** `rooms`: as salas montadas da cena (a do escritório traz a praça e as mesas). */
  feed(feed: OfficeFeed | null, layout: Office3DLayout, rooms: ReadonlyMap<string, RoomView>): void {
    this.last = { feed, layout, rooms }
    this.pulses.feed(feed, layout, rooms.get(OFFICE_ID)?.zone('plaza').lod ?? null)
    if (feed) this.crowd.setShelfTrips(scanMemorySequences(feed, layout.characters.map((c) => c.model), this.memoriesDir))
    this.papers(feed, layout, rooms)
  }

  private papers(feed: OfficeFeed | null, layout: Office3DLayout, rooms: ReadonlyMap<string, RoomView>): void {
    for (const r of layout.rooms) {
      const view = rooms.get(r.id)
      if (view) syncMemoryPapers(view, r, layout, feed, this.memoriesDir)
    }
  }

  animate(dt: number): boolean {
    return this.pulses.animate(dt)
  }

  dispose(): void {
    this.disposed = true
    this.last = null
    this.pulses.dispose()
  }
}
