import { describe, expect, it } from 'vitest'
import { BubbleLayout, EDGE, GAP, HYST, isCompact, liftOf, newBox, SLOT_COMPACT, SLOT_FRESH, SLOT_NONE, STACK_TRIES, type BubbleBox } from './bubbleLayout'

const W = 1600
const CW = 30
const CH = 28
const BW = 200
const BH = 60

/** Caixa com a ponta sem empilhar em (ax, ay) e o balão inteiro w×h. */
const box = (ax: number, ay: number, w = BW, h = BH): BubbleBox => Object.assign(newBox(), { ax, ay, w, h })

function run(boxes: BubbleBox[], layout = new BubbleLayout(8), compactOnly = false, top = EDGE): BubbleBox[] {
  layout.run(boxes, boxes.length, W, top, compactOnly, CW, CH)
  return boxes
}

/** Um quadro novo com o que o quadro anterior decidiu (o que speech.ts faz). */
function next(boxes: BubbleBox[], layout: BubbleLayout, compactOnly = false): BubbleBox[] {
  for (const b of boxes) b.prev = b.slot
  return run(boxes, layout, compactOnly)
}

type Rect = readonly [number, number, number, number]
function rectOf(b: BubbleBox): Rect {
  const w = isCompact(b.slot) ? CW : b.w
  const h = isCompact(b.slot) ? CH : b.h
  return [b.x - w / 2, b.y - h, b.x + w / 2, b.y]
}
const overlaps = (a: Rect, b: Rect): boolean => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

function expectNoOverlap(boxes: BubbleBox[]): void {
  const shown = boxes.filter((b) => b.slot !== SLOT_NONE)
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(overlaps(rectOf(shown[i]), rectOf(shown[j]))).toBe(false)
}

describe('bubbleLayout — balões sem sobreposição em tela', () => {
  it('sem colisão: cada balão fica inteiro na cabeça', () => {
    const [a, b] = run([box(300, 400), box(900, 420)])
    expect([a.slot, a.x, a.y]).toEqual([0, 300, 400])
    expect([b.slot, b.x, b.y]).toEqual([0, 900, 420])
  })

  it('2 colidindo: o segundo sobe GAP px acima do primeiro, no x da cabeça dele (1 andar)', () => {
    const [a, b] = run([box(500, 400), box(560, 410)])
    expect(a.slot).toBe(0)
    expect([b.slot, liftOf(b.slot), isCompact(b.slot)]).toEqual([1, 1, false])
    expect(b.x).toBe(560)
    expect(b.y).toBe(400 - BH - GAP)
    expectNoOverlap([a, b])
  })

  it('3 em pilha: o terceiro sobe dois andares, sempre GAP px acima de quem está embaixo', () => {
    const boxes = run([box(500, 400), box(500, 400), box(520, 395)])
    expect(boxes.map((b) => b.slot)).toEqual([0, 1, 2])
    expect(boxes.map((b) => b.y)).toEqual([400, 400 - BH - GAP, 400 - 2 * (BH + GAP)])
    expect(STACK_TRIES).toBe(2)
    expectNoOverlap(boxes)
  })

  it('sem espaço para subir (topo do palco): vira ícone compacto na cabeça', () => {
    // A encosta no topo: B não tem para onde subir, mas o ícone dele, ao lado de A, cabe.
    const [a, b] = run([box(500, BH + 10), box(640, BH + 10)])
    expect(a.slot).toBe(0)
    expect(b.slot).toBe(SLOT_COMPACT)
    expect([isCompact(b.slot), liftOf(b.slot)]).toEqual([true, 0])
    expect([b.x, b.y]).toEqual([640, BH + 10])
    expectNoOverlap([a, b])
  })

  it('pilha cheia (2 tentativas): o quarto vira ícone; sem lugar nem para o ícone, não aparece', () => {
    const boxes = run([box(500, 400), box(500, 400), box(500, 400), box(640, 400), box(500, 400)])
    expect(boxes.map((b) => b.slot)).toEqual([0, 1, 2, SLOT_COMPACT, SLOT_NONE])
    expect([boxes[3].x, boxes[3].y]).toEqual([640, 400])
    expectNoOverlap(boxes)
    // O ícone também empilha: o balão alto não cabe acima de A (topo do palco), o ícone cabe.
    const [a, i] = run([box(500, 140), box(520, 140, BW, 100)])
    expect(a.slot).toBe(0)
    expect([i.slot, isCompact(i.slot), liftOf(i.slot)]).toEqual([SLOT_COMPACT + 1, true, 1])
    expect([i.x, i.y]).toEqual([520, 140 - BH - GAP])
    expectNoOverlap([a, i])
  })

  it('ordem por prioridade: quem vem antes fica na cabeça, quem vem depois cede', () => {
    const [p, r] = run([box(500, 400), box(540, 400)])
    expect([p.slot, r.slot]).toEqual([0, 1])
    expect(p.y).toBe(400)
    const [r2, p2] = run([box(540, 400), box(500, 400)])
    expect([r2.slot, p2.slot]).toEqual([0, 1])
    expect(r2.y).toBe(400)
    expect(p2.y).toBe(400 - BH - GAP)
  })

  it('histerese: cabeça tremendo na fronteira não troca de andar; voltar exige HYST px de folga', () => {
    const layout = new BubbleLayout(8)
    const a = box(500, 400)
    const b = box(500 + BW + 1, 400) // 1 px de folga à direita de A
    const boxes = [a, b]
    run(boxes, layout)
    expect(b.slot).toBe(0)
    b.ax -= 2 // encostou: cobre A por 1 px → sobe já (vaga pior não espera)
    next(boxes, layout)
    expect(b.slot).toBe(1)
    for (const dx of [2, -2, 2, -2, 2]) {
      b.ax += dx // tremendo em volta da fronteira
      next(boxes, layout)
      expect(b.slot).toBe(1)
    }
    b.ax = 500 + BW + HYST + 1 // folga maior que HYST: volta para a cabeça
    next(boxes, layout)
    expect([b.slot, b.y]).toEqual([0, 400])
    // Quem acabou de entrar na disputa não tem histerese: 1 px de folga basta.
    const c = box(500 + BW + 1, 400)
    expect(c.prev).toBe(SLOT_FRESH)
    run([box(500, 400), c], layout)
    expect(c.slot).toBe(0)
  })

  it('x limitado para não cortar na borda; empilhar nunca sobe além do topo livre (abaixo da barra)', () => {
    const [l, r] = run([box(5, 400), box(W - 5, 400)])
    expect(l.x).toBe(BW / 2 + EDGE)
    expect(r.x).toBe(W - BW / 2 - EDGE)
    const [wide] = run([box(300, 400, W, BH)])
    expect(wide.x).toBe(W / 2)
    // Pilha alta: nenhum balão empilhado fica acima do topo livre.
    for (const top of [EDGE, 56]) {
      const boxes = run([box(500, 140), box(500, 140), box(500, 140)], new BubbleLayout(8), false, top)
      expect(boxes[1].slot).toBe(top === EDGE ? 1 : SLOT_NONE)
      for (const b of boxes) if (b.slot !== SLOT_NONE && liftOf(b.slot) > 0) expect(rectOf(b)[1]).toBeGreaterThanOrEqual(top)
      expectNoOverlap(boxes)
    }
  })

  it('só ícones (zoom longe): o balão inteiro nem é tentado e os ícones também empilham', () => {
    const [a, b, c] = run([box(500, 400), box(505, 400), box(900, 400)], new BubbleLayout(8), true)
    expect([a.slot, b.slot, c.slot]).toEqual([SLOT_COMPACT, SLOT_COMPACT + 1, SLOT_COMPACT])
    expect(b.y).toBe(400 - CH - GAP)
    expectNoOverlap([a, b, c])
  })

  it('reaproveita o estado: o quadro seguinte não herda retângulos, e passou da capacidade não aparece', () => {
    const layout = new BubbleLayout(2)
    const boxes = [box(500, 400), box(500, 400), box(900, 400)]
    run(boxes, layout)
    expect(boxes.map((b) => b.slot)).toEqual([0, 1, SLOT_NONE])
    const again = [box(500, 400), box(900, 400)]
    run(again, layout)
    expect(again.map((b) => b.slot)).toEqual([0, 0])
  })
})
