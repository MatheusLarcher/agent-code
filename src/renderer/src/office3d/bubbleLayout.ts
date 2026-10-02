/**
 * Des-sobreposição dos balões de fala em espaço de tela — PURO (sem DOM, sem three).
 *
 *   const layout = new BubbleLayout(capacidade)               // um por palco
 *   layout.run(boxes, n, width, top, compactOnly, cw, ch)     // a cada quadro; nada aloca
 *
 * boxes[0..n) chegam na ordem de prioridade (speech.ts: a mesma da escolha dos
 * balões à vista) e quem vem antes escolhe o lugar primeiro. Entrada de cada
 * caixa: (ax, ay) = onde a ponta encosta sem empilhar (logo acima da cabeça, px
 * do palco), hy = o centro da cabeça (px), (w, h) = o balão inteiro já na escala
 * e `prev` = a vaga do quadro anterior. O retângulo vai de (x − w/2, y − h) a
 * (x + w/2, y), com (x, y) = a ponta; virado, de (x − w/2, y) a (x + w/2, y + h).
 * Nenhum balão passa de `top` (o y livre do palco, abaixo da barra do HUD).
 * Cada caixa fica na primeira opção livre, nesta ordem:
 *   1. o balão inteiro na cabeça. Se o topo passaria de `top`, desce no mesmo x
 *      até caber — a ponta só se aproxima da cabeça, sem entrar nela (para a
 *      HEAD_CLEAR do caminho centro → ponta). Nem assim cabe (a cabeça está
 *      colada na barra): vira para baixo da cabeça, com a ponta para cima;
 *   2. empilhado: a ponta GAP px acima do topo do retângulo mais alto com que
 *      colidiu, até STACK_TRIES vezes (sem subir além de `top`);
 *   3. os mesmos passos como ícone compacto (cw × ch);
 *   4. sem lugar nem para o ícone: não aparece (SLOT_NONE).
 * Saída: (x, y) da ponta e a vaga — 0..STACK_TRIES balão inteiro (andares
 * subidos), FLIP virado, SLOT_COMPACT.. o mesmo como ícone, SLOT_NONE nenhuma. O
 * x é limitado para o balão não ser cortado na borda; o y na cabeça só se mexe
 * pela barra (a ponta continua apontando para a cabeça).
 * Histerese: ir para uma vaga MELHOR que `prev` exige HYST px de folga em volta —
 * cabeça balançando na fronteira não faz o balão pular de andar a cada quadro —
 * e quem estava virado só desvira com HYST px de folga entre a barra e a cabeça.
 */

/** Quantas vezes um balão sobe para não cobrir outro (depois disso, vira ícone). */
export const STACK_TRIES = 2
/** Dentro de cada modo, depois dos andares: virado (embaixo da cabeça, ponta para cima). */
const FLIP = STACK_TRIES + 1
const PER_MODE = FLIP + 1
/** Vagas: 0..2 balão inteiro (andares subidos), 3 virado; 4..7 o mesmo como ícone compacto; 8 nenhuma. */
export const SLOT_COMPACT = PER_MODE
export const SLOT_NONE = 2 * PER_MODE
/**
 * A ponta na cabeça não chega mais perto do centro dela que esta fração do caminho
 * até a ponta sem empilhar (ANCHOR_UP 0,7 m → 0,21 m: logo fora da cabeça de 0,15 m).
 * Virado, a ponta fica à mesma distância embaixo dela.
 */
export const HEAD_CLEAR = 0.3
/** `prev` de quem não estava na disputa no quadro anterior: sem histerese. */
export const SLOT_FRESH = -1
/** Espaço entre balões empilhados (px). */
export const GAP = 6
/** Folga para voltar a uma vaga melhor (px). ≤ GAP: o empilhado não "colide" com quem está embaixo dele. */
export const HYST = 4
/** Margem até a borda do palco (px). */
export const EDGE = 8

export interface BubbleBox {
  /** Entrada: ponta sem empilhar e centro da cabeça (px; hy NaN = desconhecido, nunca vira), balão inteiro já na escala (px) e a vaga do quadro anterior. */
  ax: number
  ay: number
  hy: number
  w: number
  h: number
  prev: number
  /** Saída: ponta (px) e vaga. */
  x: number
  y: number
  slot: number
}

export function newBox(): BubbleBox {
  return { ax: 0, ay: 0, hy: NaN, w: 0, h: 0, prev: SLOT_FRESH, x: 0, y: 0, slot: SLOT_NONE }
}

const inUse = (slot: number): boolean => slot >= 0 && slot < SLOT_NONE
/** A vaga é o ícone compacto? */
export const isCompact = (slot: number): boolean => slot >= SLOT_COMPACT && slot < SLOT_NONE
/** Virado: embaixo da cabeça, a ponta para cima ((x, y) é o meio da borda de cima). */
export const isFlipped = (slot: number): boolean => inUse(slot) && slot % PER_MODE === FLIP
/** Andares que o balão subiu (0 na cabeça, virado ou sem vaga). */
export const liftOf = (slot: number): number => (inUse(slot) && slot % PER_MODE !== FLIP ? slot % PER_MODE : 0)

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

  /** Tenta w×h na cabeça (ou virado embaixo dela) e subindo; true se coube (vaga = base + andares, ou base + FLIP). */
  private fit(b: BubbleBox, w: number, h: number, base: number, width: number, top: number): boolean {
    const half = w / 2
    const x = (half + EDGE) * 2 >= width ? width / 2 : Math.min(width - half - EDGE, Math.max(half + EDGE, b.ax))
    // Na cabeça, o topo não passa de `top` (a barra cobriria o balão): desce no mesmo x, até `lowest`
    // (mais, a ponta entraria na cabeça). Sem espaço entre a barra e a cabeça: vira para baixo dela.
    const clear = (b.hy - b.ay) * HEAD_CLEAR
    const lowest = b.hy - clear
    const pinned = top + h
    if (pinned > b.ay && pinned > lowest - (b.prev === base + FLIP ? HYST : 0)) {
      const y = Math.max(b.hy + clear, top)
      return this.place(b, x, half, y, y + h, y, base + FLIP) < 0
    }
    let y = Math.max(b.ay, pinned)
    for (let lift = 0; lift <= STACK_TRIES; lift++) {
      if (lift > 0 && y - h < top) return false
      const hit = this.place(b, x, half, y - h, y, y, base + lift)
      if (hit < 0) return true
      y = this.rects[hit * 4 + 1] - GAP
    }
    return false
  }

  /** Põe a caixa no retângulo x ± half, y0..y1 (ponta em `tip`) se nada cruzar; senão devolve o que cruzou (−1 = pôs). */
  private place(b: BubbleBox, x: number, half: number, y0: number, y1: number, tip: number, slot: number): number {
    const pad = b.prev !== SLOT_FRESH && slot < b.prev ? HYST : 0
    const hit = this.hit(x - half - pad, y0 - pad, x + half + pad, y1 + pad)
    if (hit >= 0) return hit
    b.x = x
    b.y = tip
    b.slot = slot
    this.add(x - half, y0, x + half, y1)
    return -1
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
