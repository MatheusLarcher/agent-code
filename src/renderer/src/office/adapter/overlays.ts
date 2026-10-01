/**
 * Estado visual contínuo das animações 7, 9 e 10 e do post-it do PO — o que
 * não é "uma animação na fila", e sim um móvel ou balão que fica ligado
 * enquanto o fato vale:
 *
 *   7  impressora da sala pisca com contador enquanto houver tarefa em
 *      segundo plano numa conversa dela; apaga quando a lista zera;
 *   9  pilha de papéis na MESA do principal, em degraus (80/90/95%);
 *   10 balão de ondas no principal da conversa lida em voz;
 *   PO o post-it do kanban da sala passa para "feito" quando o PO cola um.
 *
 * Barato por quadro: o feed é processado só quando chega; a arte consulta
 * mapas pequenos (variantOf é O(1)).
 */
import type { FurnitureVariant } from '../art/furniture'
import type { OfficeState } from '../engine/officeState'
import type { PlacedFurniture } from '../engine/types'
import type { OfficeDirector } from './director'
import type { OfficeFeed } from './feed'
import { deriveOverlayState, type PileLevel } from './moreTriggers'

export class OfficeOverlays {
  /** Contagem por sala (roomId → tarefas). */
  readonly printers = new Map<string, number>()
  /** Pilha por mesa (deskUid → degrau). */
  readonly piles = new Map<string, PileLevel>()
  /** Salas cujo PO já colou o post-it (a coluna dele mudou). */
  readonly kanbanMoved = new Set<string>()
  private speaker: number | null = null

  constructor(
    private readonly state: OfficeState,
    private readonly director: Pick<OfficeDirector, 'idOf'>
  ) {}

  /** Feed novo (depois do director.apply): refaz os mapas e o balão de voz. */
  update(feed: OfficeFeed): void {
    const o = deriveOverlayState(feed)
    this.printers.clear()
    for (const [room, n] of o.printers) this.printers.set(room, n)
    this.piles.clear()
    for (const [cid, level] of o.piles) {
      const desk = this.deskOf(cid)
      if (desk) this.piles.set(desk, level)
    }
    const speaker = o.speakingConvId ? this.director.idOf(`conv:${o.speakingConvId}`) : null
    if (speaker !== this.speaker) {
      if (this.speaker !== null) this.state.setSpeaking(this.speaker, false)
      if (speaker !== null) this.state.setSpeaking(speaker, true)
      this.speaker = speaker
    }
  }

  /** O PO colou o post-it: no quadro desta sala, ele muda de coluna. */
  moveKanban(roomId: string): void {
    this.kanbanMoved.add(roomId)
  }

  /** Variante do móvel com as sobreposições; null = nada muda (usa a base). */
  variantOf(f: PlacedFurniture, base: FurnitureVariant, t: number): FurnitureVariant | null {
    if (f.kind === 'impressora') {
      const n = f.roomId ? this.printers.get(f.roomId) ?? 0 : 0
      if (n === 0) return null
      return { ...base, blink: Math.floor(t * 2) % 2 === 1, paperLift: Math.floor(t * 2) % 3, count: n }
    }
    if (f.kind === 'quadro-kanban') return f.roomId && this.kanbanMoved.has(f.roomId) ? { ...base, moved: true } : null
    if (f.kind === 'mesa') {
      const pile = this.piles.get(f.uid)
      return pile ? { ...base, pile } : null
    }
    return null
  }

  private deskOf(convId: string): string | null {
    const id = this.director.idOf(`conv:${convId}`)
    const seatId = id !== null ? this.state.getCharacter(id)?.seatId : null
    return seatId ? this.state.seats.get(seatId)?.deskUid ?? null : null
  }
}
