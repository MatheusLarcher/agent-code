/**
 * Altura da caixa de digitação do Composer: vazia tem UMA linha (a altura dos
 * botões, 21px de linha + 4,5px em cima e embaixo = 30px), cada linha a mais
 * soma uma altura de linha, até MAX_LINES; dali em diante a caixa rola.
 *
 * A caixa é `box-sizing: border-box`, então `scrollHeight` e o resultado já
 * incluem o padding vertical.
 *
 * O piso tem UMA fonte: o `min-height` do styles.css
 * (`calc(1lh + 2 * var(--composer-pad-y))`), que o navegador resolve em px e
 * `boxMetrics` lê do estilo computado. Só quando não há valor em px (o jsdom não
 * resolve `calc`/`lh`) o piso é a mesma conta: 1 linha + padding.
 */
export const MAX_LINES = 8

export interface BoxMetrics {
  /** scrollHeight da caixa medida com `height: auto` (padding incluso). */
  scrollHeight: number
  /** Altura de uma linha, em px. */
  lineHeight: number
  /** paddingTop + paddingBottom, em px. */
  padY: number
  /** Piso em px (o `min-height` computado). Sem ele: 1 linha + padding. */
  minHeight?: number
  /** Teto em px (o `max-height` computado, ex.: as 3 linhas do Agent Manager minimizado).
   *  Sem ele (ou "none"): só o de `maxLines`. */
  maxHeight?: number
}

type BoxStyle = Pick<CSSStyleDeclaration, 'lineHeight' | 'fontSize' | 'paddingTop' | 'paddingBottom' | 'minHeight'> &
  Partial<Pick<CSSStyleDeclaration, 'maxHeight'>>

/** Valor CSS em px (ex.: "30px"); qualquer outra coisa ("calc(...)", "auto", "") é null. */
function cssPx(v: string): number | null {
  const s = v.trim()
  if (!s.endsWith('px')) return null
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : null
}

/** `line-height` em px (o computado pode vir sem unidade, ex.: "1.5", como no jsdom). */
export function lineHeightPx(cs: Pick<CSSStyleDeclaration, 'lineHeight' | 'fontSize'>): number {
  const lh = parseFloat(cs.lineHeight)
  if (!Number.isFinite(lh) || lh <= 0) return 21
  if (cs.lineHeight.trim().endsWith('px')) return lh
  const fs = parseFloat(cs.fontSize)
  return Number.isFinite(fs) && fs > 0 ? lh * fs : 21
}

/** As medidas da caixa a partir do estilo computado e do scrollHeight com `height: auto`. */
export function boxMetrics(cs: BoxStyle, scrollHeight: number): BoxMetrics {
  const padY = (cssPx(cs.paddingTop) ?? 0) + (cssPx(cs.paddingBottom) ?? 0)
  const minHeight = cssPx(cs.minHeight)
  const maxHeight = cssPx(cs.maxHeight ?? '')
  return {
    scrollHeight,
    lineHeight: lineHeightPx(cs),
    padY,
    ...(minHeight && minHeight > 0 ? { minHeight } : {}),
    ...(maxHeight && maxHeight > 0 ? { maxHeight } : {})
  }
}

/**
 * Altura da caixa e se ela rola. Nunca menos que o piso, e rola só acima de
 * `maxLines`. Uma linha mais alta que as outras (emoji, CJK, miniatura) soma 1-2px
 * ao scrollHeight: até meia linha acima do teto a caixa acompanha o conteúdo e NÃO
 * rola, senão 8 linhas assim já ativariam a rolagem. Uma 9ª linha passa dessa folga.
 * Um `max-height` do CSS abaixo disso (o Agent Manager minimizado: 3 linhas) é teto
 * duro: acima dele a caixa rola — o navegador já não a deixaria passar dali.
 */
export function composerBoxHeight(m: BoxMetrics, maxLines = MAX_LINES): { height: number; scroll: boolean } {
  const min = m.minHeight ?? m.lineHeight + m.padY
  if (m.maxHeight !== undefined && m.maxHeight < m.lineHeight * maxLines + m.padY + m.lineHeight / 2) {
    const cap = Math.max(m.maxHeight, min)
    return m.scrollHeight > cap ? { height: cap, scroll: true } : { height: Math.max(m.scrollHeight, min), scroll: false }
  }
  const max = m.lineHeight * maxLines + m.padY
  if (m.scrollHeight > max + m.lineHeight / 2) return { height: Math.max(max, min), scroll: true }
  return { height: Math.max(m.scrollHeight, min), scroll: false }
}
