import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Group, Ray, Vector3 } from 'three'
import { roomFurniture } from '../furniture'
import { createKit, type Kit } from '../kit'
import { layoutOffice } from '../layout'
import { createBoardKit, type BoardKit } from './boardKit'
import { BOARD_ROWS, boardColumns, columnAt, FACE_Z, PAPER_H, PAPER_Z, parsePileKey, slotPos } from './boardLayout'
import { BoardMirror } from './boardMirror'
import { boardSnap } from './boardModel'
import { at, item } from './boardTestKit'
import { BoardView } from './boardView'

let kit: Kit
let bk: BoardKit

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  kit = createKit(1)
  bk = createBoardKit()
})

afterEach(() => {
  bk.dispose()
  kit.dispose()
  vi.restoreAllMocks()
})

const room = () => layoutOffice({ rooms: [{ id: 'r0', projectKey: 'r0', name: 'Sala', icon: null, principals: 0 }], characters: [] }).rooms[0]

function setup(items = [item('a'), item('b', { sourceStatus: 'in_progress' })]) {
  const r = room()
  const f = roomFurniture(r)
  const view = new BoardView(kit, bk, new Group(), r.id, f.board)
  const mirror = new BoardMirror()
  mirror.setTarget(boardSnap({ available: true, items }), 0, true)
  view.apply(mirror, false, () => '#c33')
  /** Centro do papel no quadro (local). */
  const center = (id: string): Vector3 => {
    const v = new Vector3()
    view.paperWorld(id, v)
    return v.sub(view.root.position).setY(v.y - PAPER_H / 2)
  }
  /** Roda quadros até assentar; devolve quantos quadros animaram. */
  const run = (max = 400): number => {
    let n = 0
    while (n < max && view.frame(1 / 60, 0)) n++
    return n
  }
  return { r, f, view, mirror, center, run }
}

/** O índice de triângulo do papel na célula (quad = 1 + célula; 2 triângulos por quad). */
function faceOfCard(view: BoardView, id: string): number {
  for (let tri = 0; tri < 2 * 22; tri += 2) if (view.keyAt(tri) === `card:${id}`) return tri
  return -1
}

describe('kanban na parede (boardView)', () => {
  it('cada cartão vira um papel no lugar da coluna dele, na ordem do Quadro; pick devolve card:<id>', () => {
    const s = setup([item('a'), item('c'), item('b', { sourceStatus: 'in_progress' })])
    s.run()
    const a = s.center('a')
    const c = s.center('c')
    const b = s.center('b')
    expect(columnAt(a.x, a.y)).toBe(0)
    expect(columnAt(b.x, b.y)).toBe(1)
    expect(a.y).toBeGreaterThan(c.y)
    expect(Math.abs(a.y - slotPos(0, 0).y)).toBeLessThan(0.02)
    expect(faceOfCard(s.view, 'a')).toBeGreaterThan(0)
    expect(s.view.keyAt(0)).toBeNull() // a face (fundo) não é nada
  })

  it(`coluna com mais de ${BOARD_ROWS}: ${BOARD_ROWS - 1} papéis e a pilha "+K" com a chave da coluna`, () => {
    const many = Array.from({ length: 9 }, (_, i) => item(`p${i}`, { updatedAt: at(9 - i) }))
    const s = setup(many)
    expect(boardColumns(s.mirror.shown)[0]).toMatchObject({ count: 9, pile: 9 - (BOARD_ROWS - 1) })
    const keys = [...new Set(Array.from({ length: 44 }, (_, tri) => s.view.keyAt(tri)).filter(Boolean))]
    expect(keys.filter((k) => k?.startsWith('card:'))).toHaveLength(BOARD_ROWS - 1)
    const pile = keys.find((k) => k?.startsWith('pile:'))
    expect(parsePileKey(pile as string)).toEqual({ roomId: 'r0', status: 'pending' })
  })

  it('mudança: o papel desliza até a coluna nova (anima) e assenta; direto (aba escondida) não anima', () => {
    const s = setup()
    s.mirror.setTarget(boardSnap({ available: true, items: [item('a', { sourceStatus: 'completed', revision: 2 }), item('b', { sourceStatus: 'in_progress' })] }), 10)
    s.mirror.applyCard('a')
    s.view.apply(s.mirror, true, () => '#c33')
    const first = s.view.frame(1 / 60, 0)
    expect(first).toBe(true)
    const mid = s.center('a')
    expect(columnAt(mid.x, mid.y)).not.toBe(2)
    expect(s.run()).toBeGreaterThan(5)
    const end = s.center('a')
    expect(columnAt(end.x, end.y)).toBe(2)
    expect(end.z).toBeCloseTo(PAPER_Z, 1)
    // Direto: já no lugar, nada anda.
    s.mirror.setTarget(boardSnap({ available: true, items: [item('a', { revision: 3 }), item('b', { sourceStatus: 'in_progress' })] }), 20)
    s.mirror.applyCard('a')
    s.view.apply(s.mirror, false, () => '#c33')
    expect(s.run()).toBeLessThanOrEqual(1)
    const back = s.center('a')
    expect(columnAt(back.x, back.y)).toBe(0)
  })

  it('arrasto do usuário: o retrato que confirma não reanima (o papel já está lá)', () => {
    const s = setup([item('x', { sourceStatus: 'in_progress' }), item('a')])
    s.run()
    expect(s.view.beginDrag('a')).toBe(true)
    s.view.dragTo(slotPos(1, 0).x, slotPos(1, 0).y)
    s.run()
    s.mirror.userMove('a', 'in_progress')
    s.view.endDrag()
    s.run()
    s.mirror.endUserMove('a', true, 50)
    const placed = s.center('a')
    s.mirror.setTarget(boardSnap({ available: true, items: [item('a', { poStatus: 'in_progress', revision: 2, updatedAt: at(30) }), item('x', { sourceStatus: 'in_progress' })] }), 60)
    s.mirror.applyCard('a')
    s.view.apply(s.mirror, true, () => '#c33')
    expect(s.run()).toBe(0)
    expect(s.center('a').distanceTo(placed)).toBeLessThan(1e-6)
  })

  it('cartão que sai vai para o cesto e libera o papel; o novo nasce no bloquinho', () => {
    const s = setup()
    s.run()
    s.mirror.setTarget(boardSnap({ available: true, items: [item('b', { sourceStatus: 'in_progress' }), item('n')] }), 10)
    s.mirror.applyCard('a')
    s.mirror.applyCard('n')
    s.view.apply(s.mirror, true, () => '#c33')
    expect(s.view.has('a')).toBe(false) // saindo: não é mais clicável
    const born = s.center('n')
    expect(born.y).toBeLessThan(slotPos(0, 0).y - 0.3) // começa embaixo, no bloquinho
    s.run()
    expect(s.view.paperWorld('a', new Vector3())).toBe(false)
    expect(faceOfCard(s.view, 'n')).toBeGreaterThan(0)
  })

  it('LOD: PERTO com textura (e o redesenho pendente sai aqui), MÉDIO só a cor, LONGE sem bloquinho/cesto', () => {
    const s = setup()
    expect(s.view.paintPending).toBe(true)
    s.view.frame(0, 1)
    expect([s.view.near.visible, s.view.mid.visible]).toEqual([false, true])
    expect(s.view.paintPending).toBe(true) // longe da câmera não redesenha
    s.view.frame(0, 0)
    expect([s.view.near.visible, s.view.mid.visible]).toEqual([true, false])
    expect(s.view.paintPending).toBe(false)
  })

  it('o raio acha o ponto na face (o arrasto) e a coluna sob ele', () => {
    const s = setup()
    const out = { x: 0, y: 0 }
    const target = new Vector3(s.f.board.x + slotPos(2, 1).x, s.f.board.y + slotPos(2, 1).y, s.f.board.z + FACE_Z)
    const origin = new Vector3(target.x, target.y + 2, target.z + 6)
    const ray = new Ray(origin, target.clone().sub(origin).normalize())
    expect(s.view.localPoint(ray, out)).toBe(true)
    expect(columnAt(out.x, out.y)).toBe(2)
  })
})
