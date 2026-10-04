/**
 * O kanban do escritório na cena — UM quadro físico (boardView.ts) no centro
 * da parede do fundo, preso ao grupo da zona da praça (some junto quando ela
 * sai da tela), mostrando o Quadro de UM projeto por vez (`show`). Os dados
 * continuam por projeto (boardSync.ts): `apply(projeto, …)` só vale para o
 * projeto que está na parede.
 *
 *   syncRooms(layout, views)  o escritório (a zona da praça e o lugar do quadro);
 *   show(projeto)             troca o projeto da parede (o espelho dele é reaplicado);
 *   apply(projeto, mirror, …) a parede do espelho daquele projeto, se for o mostrado;
 *   animate(dt)               só com a praça À VISTA anda; fora da tela vai direto;
 *   setTabs(abas)             os projetos com quadro: a faixa do título mostra o da parede e as abas;
 *   pickTargets / keyAt       papel → `card:<id>`, pilha → `pile:<projeto>|<status>`, aba → `tab:<projeto>`.
 *
 * Papel só é clicável PERTO ou MÉDIO; arrastar, só PERTO (com o texto à vista).
 */
import type { Group, Object3D, Vector3 } from 'three'
import type { RoomView } from '../decor'
import type { BoardPlace } from '../furniture'
import type { Kit } from '../kit'
import type { RoomLayout } from '../layout'
import type { Lod } from '../lod'
import type { RoomLod } from '../roomLod'
import { createBoardKit, type BoardKit } from './boardKit'
import type { BoardMirror } from './boardMirror'
import type { BoardTitleInfo } from './boardTitle'
import { BoardView, type PinOf } from './boardView'

interface Wall {
  readonly room: RoomView
  readonly group: Group
  readonly lod: RoomLod
  readonly place: BoardPlace
}

export class Boards {
  readonly kit: BoardKit
  private wall: Wall | null = null
  private current: BoardView | null = null
  /** O projeto que está na parede; null sem nenhum. */
  shown: string | null = null
  /** Os projetos com quadro (as abas), na ordem do escritório. */
  private tabs: readonly BoardTitleInfo[] = []
  /** Projeto novo na parede (ou o escritório refeito): quem tem o espelho reaplica (sem animar). */
  onFresh: (projectId: string) => void = () => {}

  constructor(private readonly sceneKit: Kit) {
    this.kit = createBoardKit()
  }

  syncRooms(layout: readonly RoomLayout[], views: ReadonlyMap<string, RoomView>): void {
    const room = layout[0] ? views.get(layout[0].id) : undefined
    if (room && this.wall?.room === room) return
    this.current?.dispose()
    this.current = null
    if (!room) {
      this.wall = null
      return
    }
    const plaza = room.zone('plaza')
    this.wall = { room, group: plaza.group, lod: plaza.lod, place: room.furniture.board }
    const shown = this.shown
    this.shown = null
    if (shown) this.show(shown)
  }

  /** Troca o projeto da parede; o espelho dele entra pelo `onFresh` (sem animar). */
  show(projectId: string | null): void {
    if (projectId === this.shown) return
    this.current?.dispose()
    this.current = null
    this.shown = projectId
    if (!projectId || !this.wall) return
    this.current = new BoardView(this.sceneKit, this.kit, this.wall.group, projectId, this.wall.place)
    this.header()
    this.onFresh(projectId)
  }

  /** As abas (os projetos com quadro); a faixa do título acompanha. */
  setTabs(tabs: readonly BoardTitleInfo[]): void {
    this.tabs = tabs
    this.header()
  }

  private header(): void {
    const id = this.shown
    this.current?.setHeader(id ? (this.tabs.find((t) => t.id === id) ?? { id, name: id, icon: null }) : null, this.tabs)
  }

  view(roomId: string): BoardView | undefined {
    return roomId === this.shown ? (this.current ?? undefined) : undefined
  }

  /** O quadro do projeto está à vista (na parede e com a praça dentro do frustum). */
  visible(roomId: string): boolean {
    return roomId === this.shown && !!this.current && !!this.wall && !this.wall.lod.culled
  }

  level(roomId: string): Lod {
    return roomId === this.shown && this.wall ? this.wall.lod.level : 2
  }

  /** A parede passa a ser a do espelho (se o projeto é o mostrado); `animate` só vale com a praça à vista. */
  apply(roomId: string, mirror: BoardMirror, animate: boolean, pinOf: PinOf): void {
    if (roomId !== this.shown || !this.current || !this.wall) return
    this.current.apply(mirror, animate && !this.wall.lod.culled, pinOf)
  }

  /** Um quadro: anima com a praça à vista; fora dela, vai direto ao lugar. 2 enquanto algo anda. */
  animate(dt: number): 0 | 2 {
    const v = this.current
    const w = this.wall
    if (!v || !w) return 0
    if (w.lod.culled) {
      v.settle()
      return 0
    }
    return v.frame(dt, w.lod.level) ? 2 : 0
  }

  /** Malhas clicáveis: PERTO a com textura, MÉDIO a só com cor; LONGE nada. */
  pickTargets(out: Object3D[]): void {
    const v = this.current
    const w = this.wall
    if (!v || !w || w.lod.culled) return
    if (w.lod.level === 0) out.push(v.near)
    else if (w.lod.level === 1) out.push(v.mid)
  }

  /** Chave do que o raio acertou (`point`, no mundo) numa malha de quadro (null se não é quadro ou é o fundo). */
  keyAt(object: Object3D, faceIndex: number | null | undefined, point?: Vector3): string | null {
    const roomId = object.userData.boardRoom as string | undefined
    if (!roomId || faceIndex == null || roomId !== this.shown || !this.wall) return null
    const at = point ? { x: point.x - this.wall.place.x, y: point.y - this.wall.place.y } : undefined
    return this.current?.keyAt(faceIndex, at) ?? null
  }

  /** O projeto que mostra o papel na parede. */
  roomOfCard(cardId: string): string | null {
    return this.current?.has(cardId) ? this.shown : null
  }

  /** O papel sob o mouse sobe e brilha (null: nenhum). */
  hover(cardId: string | null): void {
    this.current?.hover(cardId && this.current.has(cardId) ? cardId : null)
  }

  dispose(): void {
    this.current?.dispose()
    this.current = null
    this.wall = null
    this.shown = null
    this.kit.dispose()
    this.onFresh = () => {}
  }
}
