/**
 * O kanban de UMA sala (three): moldura, canaleta, bloquinho, cesto e a malha
 * dos papéis (boardQuads.ts) com a textura da sala (boardPaint.ts). Mostra a
 * parede do espelho (boardMirror.ts) — quem decide QUANDO a parede anda é a
 * fila de passos; aqui só se leva cada papel até o lugar dele.
 *
 *   apply(mirror, animate)  novo lugar de cada papel; com `animate`, o papel
 *                           desliza (o vão fecha, a coluna destino abre espaço;
 *                           o novo sai do bloquinho, o que saiu vai para o cesto,
 *                           o empurrado entra na pilha). Sem, vai direto.
 *   frame(dt, level)        um quadro: LOD (PERTO textura, MÉDIO só a cor do
 *                           papel, LONGE sem bloquinho/cesto), redesenho
 *                           pendente (só PERTO) e o deslize. Não aloca.
 *   hover / drag / shake    o papel sobe e brilha; arrastado, segue o ponto na
 *                           face com sombra e a coluna sob ele acende; recusado, treme.
 */
import { CanvasTexture, Group, Mesh, MeshLambertMaterial, Plane, SRGBColorSpace, Sphere, Vector3, type InstancedMesh, type Ray } from 'three'
import type { BoardPlace } from '../furniture'
import type { Kit } from '../kit'
import type { Lod } from '../lod'
import { canvas2d } from '../textures'
import type { BoardKit } from './boardKit'
import { BOARD_H, BOARD_ROWS, boardColumns, CARD_KEY, clampToFace, COL_W, columnAt, columnX, FACE_H, FACE_Z, LIFT_Z, PAPER_H, PAPER_W, PAPER_Z, pileKey, slotPos, wobble } from './boardLayout'
import type { BoardMirror } from './boardMirror'
import { BOARD_COLUMNS, columnIndex, type BoardCard } from './boardModel'
import { ATLAS, CARD_CELLS, PAPER_COLORS, paintFace, paintPaper, paintPile, PILE_CELLS, PILE_COLOR, type FaceInfo, type PaperInfo } from './boardPaint'
import { buildBoardProps } from './boardProps'
import { BoardQuads } from './boardQuads'

/** Rapidez do deslize (1/s): ~0,5 s até assentar. */
const SLIDE = 8
const DRAG_FOLLOW = 28
const EPS = 0.0015
const SHAKE_S = 0.55

interface Paper {
  id: string
  cell: number
  x: number
  y: number
  z: number
  rz: number
  s: number
  tx: number
  ty: number
  tz: number
  trz: number
  ts: number
  /** Saindo (para a pilha ou o cesto): libera a célula ao chegar. */
  leaving: boolean
  shake: number
  sig: string
  info: PaperInfo
  settled: boolean
}

/** Pinta o papel: cor da camisa (CSS) do agente da conversa. */
export type PinOf = (convId: string) => string

export class BoardView {
  readonly root = new Group()
  readonly near: Mesh
  readonly mid: Mesh
  /** Versão do espelho aplicada por último. */
  version = -1
  private readonly quads: BoardQuads
  private readonly texture: CanvasTexture
  private readonly nearMat: MeshLambertMaterial
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly papers = new Map<string, Paper>()
  private readonly byCell: Array<Paper | null> = new Array(PILE_CELLS + CARD_CELLS).fill(null)
  private readonly freeCells: number[] = []
  private readonly piles = BOARD_COLUMNS.map((c) => ({ k: 0, status: c.status, shownK: -1 }))
  private readonly dirty = new Set<number>()
  private face: FaceInfo = { state: 'loading', counts: [0, 0, 0] }
  private faceSig = ''
  private faceDirty = true
  private level: Lod = 0
  private prevIds = new Set<string>()
  private mirror: BoardMirror | null = null
  private pinOf: PinOf = () => '#888'
  private hoverId: string | null = null
  private dragId: string | null = null
  private dragCol: number | null = null
  private readonly fixed: InstancedMesh
  private readonly glow: Mesh
  private readonly shadow: Mesh
  private readonly colGlow: Mesh
  private readonly props: Group
  private readonly pad: { x: number; y: number; z: number }
  private readonly bin: { x: number; y: number; z: number }
  private readonly plane = new Plane()
  private readonly hit = new Vector3()
  private t = 0

  constructor(
    kit: Kit,
    bk: BoardKit,
    parent: Group,
    readonly roomId: string,
    private readonly spot: BoardPlace
  ) {
    this.root.position.set(spot.x, spot.y, spot.z)
    parent.add(this.root)
    // Moldura, fundo, bloquinho (de onde sai o papel novo) e cesto (para onde vai o que sai).
    const fixed = buildBoardProps(kit, bk, this.root, spot)
    this.fixed = fixed.frame
    this.props = fixed.props
    this.pad = fixed.pad
    this.bin = fixed.bin

    // A textura da sala e a malha (uma para PERTO com textura, outra para MÉDIO/LONGE só com a cor).
    const { canvas, ctx } = canvas2d(ATLAS, ATLAS)
    this.ctx = ctx
    this.texture = new CanvasTexture(canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.anisotropy = kit.anisotropy
    this.nearMat = new MeshLambertMaterial({ map: this.texture })
    this.quads = new BoardQuads(new Sphere(new Vector3(0, -0.2, 0.2), 1.9))
    this.near = new Mesh(this.quads.geo, this.nearMat)
    this.mid = new Mesh(this.quads.geo, bk.mat.mid)
    for (const m of [this.near, this.mid]) {
      m.receiveShadow = true
      m.userData.boardRoom = roomId
      this.root.add(m)
    }
    this.mid.visible = false
    const overlay = (mat: Mesh['material']): Mesh => {
      const m = new Mesh(kit.geo.plane, mat)
      m.visible = false
      this.root.add(m)
      return m
    }
    this.glow = overlay(bk.mat.glow)
    this.shadow = overlay(bk.mat.shadow)
    this.colGlow = overlay(bk.mat.column)
    for (let i = PILE_CELLS; i < PILE_CELLS + CARD_CELLS; i++) this.freeCells.push(i)
    for (let q = 1; q <= PILE_CELLS + CARD_CELLS; q++) this.quads.hide(q)
    this.plane.setFromNormalAndCoplanarPoint(new Vector3(0, 0, 1), new Vector3(0, 0, spot.z + FACE_Z))
  }

  /** A parede do espelho: lugar (e conteúdo) de cada papel. */
  apply(mirror: BoardMirror, animate: boolean, pinOf: PinOf): void {
    this.mirror = mirror
    this.pinOf = pinOf
    this.version = mirror.version
    const shown = mirror.shown
    const cols = boardColumns(shown)
    const state = mirror.available === null ? 'loading' : mirror.available === false ? 'unavailable' : shown.length === 0 ? 'empty' : 'ok'
    const counts = cols.map((c) => c.count)
    const sig = `${state}|${counts.join(',')}`
    if (sig !== this.faceSig) {
      this.faceSig = sig
      this.face = { state, counts }
      this.faceDirty = true
    }
    const ids = new Set<string>()
    for (const c of shown) ids.add(c.id)
    const keep = new Set<string>()
    cols.forEach((col, ci) => {
      col.cards.forEach((card, row) => {
        keep.add(card.id)
        this.place(card, ci, row, animate)
      })
      // A pilha "+K" no último lugar da coluna.
      const pile = this.piles[ci]
      if (col.pile > 0) {
        const s = slotPos(ci, BOARD_ROWS - 1)
        this.quads.set(ci + 1, s.x, s.y, PAPER_Z, PAPER_W, PAPER_H, 0)
        this.quads.color(ci + 1, PILE_COLOR)
        if (col.pile !== pile.shownK) this.dirty.add(ci)
      } else if (pile.k > 0) {
        this.quads.hide(ci + 1)
      }
      pile.k = col.pile
    })
    for (const p of this.papers.values()) {
      if (keep.has(p.id)) continue
      if (!animate) {
        this.release(p)
        continue
      }
      if (p.leaving) continue
      p.leaving = true
      p.settled = false
      const card = ids.has(p.id) ? mirror.card(p.id) : undefined
      if (card) {
        // Empurrado para a pilha da coluna.
        const s = slotPos(columnIndex(card.status), BOARD_ROWS - 1)
        Object.assign(p, { tx: s.x, ty: s.y, trz: 0, ts: 0.9 })
      } else {
        // Saiu do quadro: vai para o cesto.
        Object.assign(p, { tx: this.bin.x, ty: this.bin.y, tz: this.bin.z, trz: 0.8, ts: 0.18 })
      }
    }
    this.prevIds = ids
    if (!animate) for (const p of this.papers.values()) this.snap(p)
  }

  private place(card: BoardCard, col: number, row: number, animate: boolean): void {
    const slot = slotPos(col, row)
    const w = wobble(card.id)
    let p = this.papers.get(card.id)
    if (p?.leaving) p.leaving = false
    if (!p) {
      const cell = this.takeCell()
      if (cell < 0) return
      const from = !animate ? null : this.prevIds.has(card.id) ? slotPos(col, BOARD_ROWS - 1) : null
      const start = !animate ? { x: slot.x, y: slot.y, z: PAPER_Z, s: 1 } : from ? { x: from.x, y: from.y, z: PAPER_Z, s: 0.9 } : { x: this.pad.x, y: this.pad.y, z: this.pad.z, s: 0.25 }
      p = { id: card.id, cell, x: start.x, y: start.y, z: start.z, rz: 0, s: start.s, tx: 0, ty: 0, tz: 0, trz: 0, ts: 1, leaving: false, shake: 0, sig: '', info: null as unknown as PaperInfo, settled: false }
      this.papers.set(card.id, p)
      this.byCell[cell] = p
    }
    p.settled = false
    if (p.id !== this.dragId) Object.assign(p, { tx: slot.x + w.dx, ty: slot.y + w.dy, tz: PAPER_Z + p.cell * 0.0004, trz: w.rz, ts: 1 })
    const info: PaperInfo = { title: card.title, status: card.status, awaiting: card.awaiting, po: card.origin === 'po', pin: this.pinOf(card.conversationId) }
    const sig = `${info.title}|${info.status}|${info.awaiting}|${info.po}|${info.pin}`
    if (sig !== p.sig) {
      p.sig = sig
      p.info = info
      this.dirty.add(p.cell)
      this.quads.color(p.cell + 1, PAPER_COLORS[card.status])
    }
  }

  private takeCell(): number {
    const c = this.freeCells.pop()
    if (c !== undefined) return c
    // Sem célula: quem ainda está saindo some já.
    for (const p of this.papers.values()) {
      if (!p.leaving) continue
      this.release(p)
      return this.freeCells.pop() ?? -1
    }
    return -1
  }

  private release(p: Paper): void {
    this.papers.delete(p.id)
    this.byCell[p.cell] = null
    this.freeCells.push(p.cell)
    this.quads.hide(p.cell + 1)
    if (this.hoverId === p.id) this.hoverId = null
  }

  private snap(p: Paper): void {
    if (p.leaving) return this.release(p)
    Object.assign(p, { x: p.tx, y: p.ty, z: p.tz, rz: p.trz, s: p.ts, settled: false })
  }

  /** Sala fora da tela (ou voltando a ela): tudo direto para o lugar, sem animar o atraso. */
  settle(): void {
    for (const p of [...this.papers.values()]) {
      if (p.id === this.dragId) continue
      this.snap(p)
      p.shake = 0
    }
  }

  /** Um quadro da sala à vista; true enquanto algo anda. */
  frame(dt: number, level: Lod): boolean {
    this.t += dt
    if (level !== this.level) {
      this.level = level
      this.near.visible = level === 0
      this.mid.visible = level !== 0
      this.props.visible = level < 2
    }
    if (level === 0) this.paint()
    let moving = false
    const k = 1 - Math.exp(-dt * SLIDE)
    const kd = 1 - Math.exp(-dt * DRAG_FOLLOW)
    for (const p of this.papers.values()) {
      if (p.settled && p.shake <= 0) continue
      const drag = p.id === this.dragId
      const hover = p.id === this.hoverId
      const tz = drag ? LIFT_Z : hover ? p.tz + 0.02 : p.tz
      const ts = p.ts * (drag ? 1.08 : hover ? 1.05 : 1)
      const kk = drag ? kd : k
      p.x += (p.tx - p.x) * kk
      p.y += (p.ty - p.y) * kk
      p.z += (tz - p.z) * k
      p.rz += (p.trz - p.rz) * k
      p.s += (ts - p.s) * k
      let sx = 0
      if (p.shake > 0) {
        p.shake = Math.max(0, p.shake - dt)
        sx = Math.sin(this.t * 48) * 0.03 * (p.shake / SHAKE_S)
      }
      const far = Math.abs(p.tx - p.x) + Math.abs(p.ty - p.y) + Math.abs(tz - p.z) + Math.abs(p.trz - p.rz) + Math.abs(ts - p.s)
      const done = far < EPS && p.shake <= 0
      // Assentou: exatamente no alvo (o próximo apply com o mesmo lugar não mexe nada).
      if (done) Object.assign(p, { x: p.tx, y: p.ty, z: tz, rz: p.trz, s: ts })
      // Em trânsito passa por cima dos outros papéis.
      const lift = far > 0.05 && !drag ? 0.012 : 0
      this.quads.set(p.cell + 1, p.x + sx, p.y, p.z + lift, PAPER_W * p.s, PAPER_H * p.s, p.rz)
      if (!done) moving = true
      else if (p.leaving) this.release(p)
      else p.settled = true
    }
    this.place3d()
    return moving
  }

  /** Brilho do papel em foco, sombra do arrastado e a coluna acesa. */
  private place3d(): void {
    const id = this.dragId ?? this.hoverId
    const p = id ? this.papers.get(id) : undefined
    const near = this.level === 0
    this.glow.visible = !!p && near
    if (p && near) {
      this.glow.position.set(p.x, p.y, p.z - 0.002)
      this.glow.rotation.z = p.rz
      this.glow.scale.set(PAPER_W * p.s + 0.05, PAPER_H * p.s + 0.05, 1)
    }
    const d = this.dragId ? this.papers.get(this.dragId) : undefined
    this.shadow.visible = !!d && near
    if (d) {
      this.shadow.position.set(d.x + 0.03, d.y - 0.035, FACE_Z + 0.004)
      this.shadow.scale.set(PAPER_W * d.s, PAPER_H * d.s, 1)
    }
    this.colGlow.visible = this.dragCol !== null && near
    if (this.dragCol !== null) {
      this.colGlow.position.set(columnX(this.dragCol), 0, FACE_Z + 0.002)
      this.colGlow.scale.set(COL_W - 0.03, FACE_H - 0.03, 1)
    }
  }

  /** Redesenho pendente (só PERTO e à vista): face, papéis e pilhas que mudaram. */
  private paint(): void {
    if (!this.faceDirty && this.dirty.size === 0) return
    const ctx = this.ctx
    if (ctx) {
      if (this.faceDirty) paintFace(ctx, this.face)
      for (const cell of this.dirty) {
        if (cell < PILE_CELLS) {
          const pile = this.piles[cell]
          if (pile.k > 0) paintPile(ctx, cell, pile.k, pile.status)
          pile.shownK = pile.k
        } else {
          const p = this.byCell[cell]
          if (p) paintPaper(ctx, cell, p.info)
        }
      }
      this.texture.needsUpdate = true
    }
    this.faceDirty = false
    this.dirty.clear()
  }

  /** Quantos redesenhos estão pendentes (testes). */
  get paintPending(): boolean {
    return this.faceDirty || this.dirty.size > 0
  }

  /** O que está sob o triângulo `faceIndex` da malha: papel, pilha ou nada. */
  keyAt(faceIndex: number): string | null {
    const q = Math.floor(faceIndex / 2)
    if (q < 1) return null
    const cell = q - 1
    if (cell < PILE_CELLS) {
      const pile = this.piles[cell]
      return pile.k > 0 ? pileKey(this.roomId, pile.status) : null
    }
    const p = this.byCell[cell]
    return p && !p.leaving ? `${CARD_KEY}${p.id}` : null
  }

  /** O ponto da face (local) sob o raio; false se o raio não cruza o plano do quadro. */
  localPoint(ray: Ray, out: { x: number; y: number }): boolean {
    if (!ray.intersectPlane(this.plane, this.hit)) return false
    out.x = this.hit.x - this.spot.x
    out.y = this.hit.y - this.spot.y
    return true
  }

  /** O papel está na parede (sem sair, sem estar arrastado por outro)? */
  has(id: string): boolean {
    const p = this.papers.get(id)
    return !!p && !p.leaving
  }

  /** O papel ainda está deslizando (não dá para pegar). */
  busy(id: string): boolean {
    const p = this.papers.get(id)
    return !p || p.leaving || (!p.settled && Math.abs(p.tx - p.x) + Math.abs(p.ty - p.y) > 0.03)
  }

  hover(id: string | null): void {
    if (id === this.hoverId) return
    for (const k of [this.hoverId, id]) {
      const p = k ? this.papers.get(k) : undefined
      if (p) p.settled = false
    }
    this.hoverId = id
  }

  beginDrag(id: string): boolean {
    const p = this.papers.get(id)
    if (!p || p.leaving) return false
    this.dragId = id
    p.settled = false
    p.trz = 0
    return true
  }

  /** O papel arrastado vai para o ponto local (preso à face); devolve a coluna sob ele. */
  dragTo(x: number, y: number): number | null {
    const p = this.dragId ? this.papers.get(this.dragId) : undefined
    if (!p) return null
    const c = clampToFace(x, y)
    p.tx = c.x
    p.ty = c.y
    p.settled = false
    this.dragCol = columnAt(c.x, c.y)
    return this.dragCol
  }

  /** Solta (o lugar novo vem do próximo apply). */
  endDrag(): void {
    const p = this.dragId ? this.papers.get(this.dragId) : undefined
    if (p) p.settled = false
    this.dragId = null
    this.dragCol = null
    if (this.mirror) this.apply(this.mirror, true, this.pinOf)
  }

  get dragging(): string | null {
    return this.dragId
  }

  shake(id: string): void {
    const p = this.papers.get(id)
    if (!p) return
    p.shake = SHAKE_S
    p.settled = false
  }

  /** Centro (mundo) do papel; false se ele não está na parede. */
  paperWorld(id: string, out: Vector3): boolean {
    const p = this.papers.get(id)
    if (!p) return false
    out.set(this.spot.x + p.x, this.spot.y + p.y + (PAPER_H * p.s) / 2, this.spot.z + p.z)
    return true
  }

  /** Topo do quadro (mundo): onde a mensagem de recusa aparece. */
  topWorld(out: Vector3): Vector3 {
    return out.set(this.spot.x, this.spot.y + BOARD_H / 2 + 0.08, this.spot.z + 0.2)
  }

  /** Topo (mundo) da pilha da coluna. */
  pileWorld(col: number, out: Vector3): Vector3 {
    const s = slotPos(col, BOARD_ROWS - 1)
    return out.set(this.spot.x + s.x, this.spot.y + s.y + PAPER_H / 2, this.spot.z + PAPER_Z)
  }

  /** Coluna do cartão na parede (null se não está). */
  columnOf(id: string): number | null {
    const c = this.mirror?.card(id)
    return c ? columnIndex(c.status) : null
  }

  dispose(): void {
    this.root.removeFromParent()
    this.fixed.dispose()
    this.quads.dispose()
    this.texture.dispose()
    this.nearMat.dispose()
    this.papers.clear()
  }
}
