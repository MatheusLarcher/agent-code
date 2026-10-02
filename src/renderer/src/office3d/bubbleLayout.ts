/**
 * Des-sobreposição dos balões de fala em espaço de tela — PURO (sem DOM, sem three).
 *
 *   const layout = new BubbleLayout(capacidade)               // um por palco
 *   layout.run(boxes, n, width, top, compactOnly, cw, ch)     // a cada quadro; nada aloca
 *
 * boxes[0..n) chegam na ordem de prioridade (speech.ts: a mesma da escolha dos
 * balões à vista) e quem vem antes escolhe o lugar primeiro. Entrada de cada
 * caixa: (ax, ay) = onde a ponta encosta sem empilhar (logo acima da cabeça, px
 * do palco), (w, h) = o balão inteiro já na escala e `prev` = a vaga do quadro
 * anterior. O retângulo vai de (x − w/2, y − h) a (x + w/2, y), com (x, y) = a
 * ponta. Cada caixa fica na primeira opção livre, nesta ordem:
 *   1. o balão inteiro na cabeça;
 *   2. empilhado: a ponta GAP px acima do topo do retângulo mais alto com que
 *      colidiu, até STACK_TRIES vezes (o balão empilhado não sobe além de `top`,
 *      o y livre do palco — abaixo da barra);
 *   3. os mesmos passos como ícone compacto (cw × ch);
 *   4. sem lugar nem para o ícone: não aparece (SLOT_NONE).
 * Saída: (x, y) da ponta e a vaga — 0..STACK_TRIES balão inteiro (andares
 * subidos), SLOT_COMPACT.. ícone, SLOT_NONE nenhuma. O x é limitado para o balão
 * não ser cortado na borda; o y na cabeça não (a ponta não descola da cabeça).
 * Histerese: ir para uma vaga MELHOR que `prev` exige HYST px de folga em volta —
 * cabeça balançando na fronteira não faz o balão pular de andar a cada quadro.
 */

/** Quantas vezes um balão sobe para não cobrir outro (depois disso, vira ícone). */
export const STACK_TRIES = 2
const PER_MODE = STACK_TRIES + 1
/** Vagas: 0..2 balão inteiro (andares subidos), 3..5 ícone compacto, 6 nenhuma. */
export const SLOT_COMPACT = PER_MODE
export const SLOT_NONE = 2 * PER_MODE
/** `prev` de quem não estava na disputa no quadro anterior: sem histerese. */
export const SLOT_FRESH = -1
/** Espaço entre balões empilhados (px). */
export const GAP = 6
/** Folga para voltar a uma vaga melhor (px). ≤ GAP: o empilhado não "colide" com quem está embaixo dele. */
export const HYST = 4
/** Margem até a borda do palco (px). */
export const EDGE = 8

export interface BubbleBox {
  /** Entrada: ponta sem empilhar (px), balão inteiro já na escala (px) e a vaga do quadro anterior. */
  ax: number
  ay: number
  w: number
  h: number
  prev: number
  /** Saída: ponta (px) e vaga. */
  x: number
  y: number
  slot: number
}

export function newBox(): BubbleBox {
  return { ax: 0, ay: 0, w: 0, h: 0, prev: SLOT_FRESH, x: 0, y: 0, slot: SLOT_NONE }
}

/** A vaga é o ícone compacto? */
export const isCompact = (slot: number): boolean => slot >= SLOT_COMPACT && slot < SLOT_NONE
/** Andares que o balão subiu (0 na cabeça ou sem vaga). */
export const liftOf = (slot: number): number => (slot >= 0 && slot < SLOT_NONE ? slot % PER_MODE : 0)

export class BubbleLayout {
  /** Retângulos já postos neste quadro: x0, y0, x1, y1. */
  private readonly rects: Float64Array
  private n = 0

  constructor(readonly capacity: number) {
    this.rects = new Float64Array(capacity * 4)
  }

  /** Posiciona boxes[0..count) nesta ordem no palco de largura `width`; `compactOnly` (zoom longe) pula o balão inteiro. */
  run(boxes: readonly BubbleBox[], count: number, width: number, top: number, compactOnly: boolean, cw: number, ch: number): void {
    this.n = 0
    for (let i = 0; i < count; i++) {
      const b = boxes[i]
      b.slot = SLOT_NONE
      if (i >= this.capacity) continue
      if (!compactOnly && this.fit(b, b.w, b.h, 0, width, top)) continue
      this.fit(b, cw, ch, SLOT_COMPACT, width, top)
    }
  }

  /** Tenta w×h na cabeça e subindo; true se coube (vaga = base + andares). */
  private fit(b: BubbleBox, w: number, h: number, base: number, width: number, top: number): boolean {
    const half = w / 2
    const x = (half + EDGE) * 2 >= width ? width / 2 : Math.min(width - half - EDGE, Math.max(half + EDGE, b.ax))
    let y = b.ay
    for (let lift = 0; lift <= STACK_TRIES; lift++) {
      if (lift > 0 && y - h < top) return false
      const slot = base + lift
      const pad = b.prev !== SLOT_FRESH && slot < b.prev ? HYST : 0
      const hit = this.hit(x - half - pad, y - h - pad, x + half + pad, y + pad)
      if (hit < 0) {
        b.x = x
        b.y = y
        b.slot = slot
        this.add(x - half, y - h, x + half, y)
        return true
      }
      y = this.rects[hit * 4 + 1] - GAP
    }
    return false
  }

  /** O retângulo posto que cruza este — o de topo mais alto, se vários; −1 se nenhum. */
  private hit(x0: number, y0: number, x1: number, y1: number): number {
    const r = this.rects
    let best = -1
    let top = Infinity
    for (let i = 0; i < this.n; i++) {
      const o = i * 4
      if (x0 < r[o + 2] && x1 > r[o] && y0 < r[o + 3] && y1 > r[o + 1] && r[o + 1] < top) {
        best = i
        top = r[o + 1]
      }
    }
    return best
  }

  private add(x0: number, y0: number, x1: number, y1: number): void {
    const r = this.rects
    const o = this.n++ * 4
    r[o] = x0
    r[o + 1] = y0
    r[o + 2] = x1
    r[o + 3] = y1
  }
}
