/**
 * Os kanbans do escritório na cena — um por sala (boardView.ts), presos ao
 * grupo da sala (somem junto quando ela sai da tela):
 *
 *   syncRooms(layout, views)  sala nova (ou refeita) ganha o quadro; a que saiu libera;
 *   apply(id, mirror, …)      a parede do espelho daquela sala;
 *   animate(dt)               só as salas À VISTA andam; fora da tela vai direto (sem atraso);
 *   pickTargets / keyAt       papel → `card:<id>`, pilha → `pile:<sala>|<status>`.
 *
 * Papel só é clicável PERTO ou MÉDIO; arrastar, só PERTO (com o texto à vista).
 */
import type { Object3D } from 'three'
import type { RoomView } from '../decor'
import type { Kit } from '../kit'
import type { RoomLayout } from '../layout'
import type { Lod } from '../lod'
import { createBoardKit, type BoardKit } from './boardKit'
import type { BoardMirror } from './boardMirror'
import { BoardView, type PinOf } from './boardView'

interface RoomBoard {
  readonly id: string
  readonly view: BoardView
  readonly room: RoomView
}

export class Boards {
  readonly kit: BoardKit
  private readonly rooms = new Map<string, RoomBoard>()
  private list: RoomBoard[] = []
  /** Sala nova ou refeita: quem tem o espelho reaplica (sem animar). */
  onFresh: (roomId: string) => void = () => {}

  constructor(private readonly sceneKit: Kit) {
    this.kit = createBoardKit()
  }

  syncRooms(layout: readonly RoomLayout[], views: ReadonlyMap<string, RoomView>): void {
    const fresh: string[] = []
    for (const r of layout) {
      const room = views.get(r.id)
      const cur = this.rooms.get(r.id)
      if (!room || cur?.room === room) continue
      cur?.view.dispose()
      const view = new BoardView(this.sceneKit, this.kit, room.group, r.id, room.furniture.board)
      this.rooms.set(r.id, { id: r.id, view, room })
      fresh.push(r.id)
    }
    const ids = new Set(layout.map((r) => r.id))
    for (const [id, b] of [...this.rooms]) {
      if (ids.has(id) && views.get(id) === b.room) continue
      b.view.dispose()
      this.rooms.delete(id)
    }
    this.list = [...this.rooms.values()]
    for (const id of fresh) this.onFresh(id)
  }

  view(roomId: string): BoardView | undefined {
    return this.rooms.get(roomId)?.view
  }

  /** A sala está à vista (não cortada pelo frustum). */
  visible(roomId: string): boolean {
    const b = this.rooms.get(roomId)
    return !!b && !b.room.lod.culled
  }

  level(roomId: string): Lod {
    return this.rooms.get(roomId)?.room.lod.level ?? 2
  }

  /** A parede da sala passa a ser a do espelho; `animate` só vale com a sala à vista. */
  apply(roomId: string, mirror: BoardMirror, animate: boolean, pinOf: PinOf): void {
    const b = this.rooms.get(roomId)
    if (!b) return
    b.view.apply(mirror, animate && !b.room.lod.culled, pinOf)
  }

  /** Um quadro: anima as salas à vista; as outras vão direto ao lugar. 2 enquanto algo anda. */
  animate(dt: number): 0 | 2 {
    let moving = false
    for (let i = 0; i < this.list.length; i++) {
      const { view, room } = this.list[i]
      if (room.lod.culled) {
        view.settle()
        continue
      }
      if (view.frame(dt, room.lod.level)) moving = true
    }
    return moving ? 2 : 0
  }

  /** Malhas clicáveis: PERTO a com textura, MÉDIO a só com cor; LONGE nada. */
  pickTargets(out: Object3D[]): void {
    for (const b of this.list) {
      if (b.room.lod.culled) continue
      const level = b.room.lod.level
      if (level === 0) out.push(b.view.near)
      else if (level === 1) out.push(b.view.mid)
    }
  }

  /** Chave do que o raio acertou numa malha de quadro (null se não é quadro ou é o fundo). */
  keyAt(object: Object3D, faceIndex: number | null | undefined): string | null {
    const roomId = object.userData.boardRoom as string | undefined
    if (!roomId || faceIndex == null) return null
    return this.rooms.get(roomId)?.view.keyAt(faceIndex) ?? null
  }

  /** A sala que mostra o papel na parede. */
  roomOfCard(cardId: string): string | null {
    for (const b of this.list) if (b.view.has(cardId)) return b.id
    return null
  }

  /** O papel sob o mouse sobe e brilha (null: nenhum). */
  hover(cardId: string | null): void {
    for (const b of this.list) b.view.hover(cardId && b.view.has(cardId) ? cardId : null)
  }

  dispose(): void {
    for (const b of this.list) b.view.dispose()
    this.rooms.clear()
    this.list = []
    this.kit.dispose()
    this.onFresh = () => {}
  }
}
