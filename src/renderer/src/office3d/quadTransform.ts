/**
 * Homografia de um retângulo para um quadrilátero, no formato do CSS: o
 * `matrix3d` que leva os cantos (0,0), (w,0), (w,h), (0,h) de um elemento a 4
 * pontos do palco (px). É a solução clássica quadrado→quadrilátero (Heckbert),
 * com u = X/w e v = Y/h. Puro (sem three): o ScreenAnchor encaixa a tela HTML
 * no monitor projetado com isto.
 */

export interface Pt {
  x: number
  y: number
}

/** Área (px²) abaixo da qual três cantos contam como alinhados. */
const MIN_AREA = 1e-6
/** O denominador da perspectiva tem de ficar positivo nos 4 cantos (sem dobra). */
const MIN_W = 1e-9

/**
 * `matrix3d` (column-major) que leva o retângulo 0..w × 0..h aos cantos
 * `quad` = [TL, TR, BR, BL]. null com tamanho não positivo, valor não finito,
 * três cantos alinhados ou quadrilátero dobrado (côncavo ou cruzado).
 */
export function quadMatrix3d(w: number, h: number, quad: readonly [Pt, Pt, Pt, Pt]): string | null {
  if (!(w > 0 && h > 0 && Number.isFinite(w) && Number.isFinite(h))) return null
  const x0 = quad[0].x
  const y0 = quad[0].y
  const x1 = quad[1].x
  const y1 = quad[1].y
  const x2 = quad[2].x
  const y2 = quad[2].y
  const x3 = quad[3].x
  const y3 = quad[3].y
  if (!Number.isFinite(x0 + y0 + x1 + y1 + x2 + y2 + x3 + y3)) return null
  // Quadrado unitário → quad: x = (a·u + b·v + x0) / (g·u + k·v + 1), y = (d·u + e·v + y0) / (idem).
  const sx = x0 - x1 + x2 - x3
  const sy = y0 - y1 + y2 - y3
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const den = dx1 * dy2 - dx2 * dy1
  if (!(Math.abs(den) > MIN_AREA)) return null
  const g = (sx * dy2 - dx2 * sy) / den
  const k = (dx1 * sy - sx * dy1) / den
  if (!(1 + g > MIN_W && 1 + k > MIN_W && 1 + g + k > MIN_W)) return null
  const a = x1 - x0 + g * x1
  const b = x3 - x0 + k * x3
  const d = y1 - y0 + g * y1
  const e = y3 - y0 + k * y3
  // [[a/w, b/h, 0, x0], [d/w, e/h, 0, y0], [0, 0, 1, 0], [g/w, k/h, 0, 1]] por colunas.
  return `matrix3d(${a / w}, ${d / w}, 0, ${g / w}, ${b / h}, ${e / h}, 0, ${k / h}, 0, 0, 1, 0, ${x0}, ${y0}, 0, 1)`
}
