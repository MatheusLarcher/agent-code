/**
 * As idas pelo escritório que o feed dispara (fora do turno de cada um):
 *   - o pulso de despacho da Central pelas trilhas (centralPulse.ts), com o
 *     gesto de enviar do agente dela;
 *   - a ida à estante de Memórias de quem consulta a memória (memoryTrips.ts):
 *     a turma recebe quem está na sequência (crowd.setShelfTrips) e o cérebro
 *     faz o resto (vai, folheia ou grava, e volta).
 * A pasta de memórias vem do main (getCacheInfo) uma vez.
 */
import type { Object3D } from 'three'
import { CENTRAL_ID } from '@shared/central'
import type { OfficeFeed } from '../office/adapter/feed'
import { principalKey } from '../office/adapter/model'
import { sendOff } from './brain'
import { CentralPulses } from './centralPulse'
import type { Crowd } from './crowd'
import type { Office3DLayout } from './layout'
import { scanMemorySequences } from './memoryTrips'
import type { RoomLod } from './roomLod'

/** A pasta de memórias (window.api.getCacheInfo); null fora do app. */
function appMemoriesDir(): Promise<string | null> {
  const api = (globalThis as { window?: { api?: { getCacheInfo?: () => Promise<{ memoriesDir?: string }> } } }).window?.api
  return api?.getCacheInfo ? api.getCacheInfo().then((i) => i.memoriesDir ?? null, () => null) : Promise.resolve(null)
}

export class OfficeErrands {
  readonly pulses: CentralPulses
  /** A pasta de memórias (Read/Grep/Glob nela é consulta). */
  memoriesDir: string | null = null

  constructor(
    parent: Object3D,
    private readonly crowd: Crowd
  ) {
    this.pulses = new CentralPulses(parent)
    this.pulses.onSend = () => {
      const b = crowd.brains.get(principalKey(CENTRAL_ID))
      if (b) sendOff(b)
    }
    void appMemoriesDir().then((d) => {
      this.memoriesDir = d
    })
  }

  feed(feed: OfficeFeed | null, layout: Office3DLayout, plazaLod: RoomLod | null): void {
    this.pulses.feed(feed, layout, plazaLod)
    if (feed) this.crowd.setShelfTrips(scanMemorySequences(feed, layout.characters.map((c) => c.model), this.memoriesDir))
  }

  animate(dt: number): boolean {
    return this.pulses.animate(dt)
  }

  dispose(): void {
    this.pulses.dispose()
  }
}
