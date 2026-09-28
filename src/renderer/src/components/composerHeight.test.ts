import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MAX_LINES, boxMetrics, composerBoxHeight, lineHeightPx } from './composerHeight'

// Métricas reais da caixa (styles.css): 14px × 1.5 = 21px de linha, 4,5px em cima e embaixo.
const LH = 21
const PAD = 9
/** scrollHeight que o Chromium dá para N linhas de texto (0 = caixa vazia não editável). */
const sh = (lines: number): number => lines * LH + PAD
const h = (lines: number) => composerBoxHeight({ scrollHeight: sh(lines), lineHeight: LH, padY: PAD })

describe('composerBoxHeight — 1 linha vazia, +21px por linha até 8, depois rola', () => {
  it('vazia = 30px (a altura dos botões), mesmo quando o navegador não mede linha nenhuma', () => {
    expect(h(0)).toEqual({ height: 30, scroll: false })
  })
  it('1 linha digitada não muda a altura', () => {
    expect(h(1)).toEqual({ height: 30, scroll: false })
  })
  it('a 2ª linha soma 21px; a 3ª também', () => {
    expect(h(2)).toEqual({ height: 51, scroll: false })
    expect(h(3)).toEqual({ height: 72, scroll: false })
  })
  it('8 linhas = 177px sem rolar; 9 e 12 ficam em 177px e rolam', () => {
    expect(MAX_LINES).toBe(8)
    expect(h(8)).toEqual({ height: 177, scroll: false })
    expect(h(9)).toEqual({ height: 177, scroll: true })
    expect(h(12)).toEqual({ height: 177, scroll: true })
  })
  it('para cada N de 1 a 8, altura = 30 + 21 × (N − 1)', () => {
    for (let n = 1; n <= 8; n++) expect(h(n).height).toBe(30 + 21 * (n - 1))
  })
})

describe('composerBoxHeight — folga no teto para linha mais alta (emoji, CJK)', () => {
  const box = (scrollHeight: number) => composerBoxHeight({ scrollHeight, lineHeight: LH, padY: PAD })
  it('8 linhas com UMA linha 1px ou 2px mais alta não rolam; a caixa mostra tudo', () => {
    expect(box(sh(8) + 1)).toEqual({ height: 178, scroll: false })
    expect(box(sh(8) + 2)).toEqual({ height: 179, scroll: false })
  })
  it('8 linhas com várias linhas 1-2px mais altas (até meia linha a mais) também não rolam', () => {
    expect(box(sh(8) + 5 * 2)).toEqual({ height: 187, scroll: false })
  })
  it('a 9ª linha passa da folga e rola, mesmo com linhas mais altas', () => {
    expect(box(sh(9))).toEqual({ height: 177, scroll: true })
    expect(box(sh(9) + 2)).toEqual({ height: 177, scroll: true })
  })
  it('abaixo do teto a linha mais alta só soma o que tem', () => {
    expect(box(sh(1) + 2)).toEqual({ height: 32, scroll: false })
  })
})

describe('piso — uma fonte só: o min-height do CSS', () => {
  const cs = (minHeight: string, lineHeight = '21px') => ({
    lineHeight, fontSize: '14px', paddingTop: '4.5px', paddingBottom: '4.5px', minHeight
  })
  it('boxMetrics lê o min-height computado (px) como piso', () => {
    expect(boxMetrics(cs('30px'), 9)).toEqual({ scrollHeight: 9, lineHeight: 21, padY: 9, minHeight: 30 })
  })
  it('se o CSS muda o piso, o JS segue o CSS (não tem um número próprio)', () => {
    expect(composerBoxHeight(boxMetrics(cs('40px'), 9)).height).toBe(40)
    expect(composerBoxHeight(boxMetrics(cs('31.3906px', '22.4px'), 9)).height).toBeCloseTo(31.39, 2)
  })
  it('sem px resolvido (jsdom: "calc(...)", vazio) o piso é 1 linha + padding, a mesma conta do CSS', () => {
    expect(boxMetrics(cs('calc(1lh + 2 * var(--composer-pad-y))'), 9).minHeight).toBeUndefined()
    expect(composerBoxHeight(boxMetrics(cs(''), 9)).height).toBe(30)
  })
})

describe('teto do CSS (max-height) — o Agent Manager minimizado: 3 linhas', () => {
  const cs = (maxHeight?: string) => ({
    lineHeight: '21px', fontSize: '14px', paddingTop: '4.5px', paddingBottom: '4.5px', minHeight: '30px',
    ...(maxHeight === undefined ? {} : { maxHeight })
  })
  const box = (lines: number, maxHeight?: string) => composerBoxHeight(boxMetrics(cs(maxHeight), sh(lines)))
  it('boxMetrics lê o max-height em px; "none" ou calc não resolvido ficam de fora', () => {
    expect(boxMetrics(cs('72px'), 9).maxHeight).toBe(72)
    expect(boxMetrics(cs('none'), 9).maxHeight).toBeUndefined()
    expect(boxMetrics(cs('calc(3lh + 9px)'), 9).maxHeight).toBeUndefined()
    expect(boxMetrics(cs(), 9).maxHeight).toBeUndefined()
  })
  it('com teto de 72px: 1 → 3 linhas crescem (30, 51, 72) sem rolar; a 4ª fica em 72 e rola', () => {
    expect([1, 2, 3].map((n) => box(n, '72px'))).toEqual([
      { height: 30, scroll: false },
      { height: 51, scroll: false },
      { height: 72, scroll: false }
    ])
    expect(box(4, '72px')).toEqual({ height: 72, scroll: true })
    expect(box(12, '72px')).toEqual({ height: 72, scroll: true })
  })
  it('um max-height acima das 8 linhas (os 200px do chat normal) não muda nada', () => {
    for (const n of [1, 3, 8, 9]) expect(box(n, '200px')).toEqual(box(n))
    expect(box(8, '200px')).toEqual({ height: 177, scroll: false })
  })
})

describe('lineHeightPx', () => {
  it('usa o valor em px do navegador', () => {
    expect(lineHeightPx({ lineHeight: '21px', fontSize: '14px' })).toBe(21)
  })
  it('converte o número sem unidade pelo font-size', () => {
    expect(lineHeightPx({ lineHeight: '1.5', fontSize: '14px' })).toBe(21)
  })
  it('sem valor utilizável ("normal", vazio) cai em 21px', () => {
    expect(lineHeightPx({ lineHeight: 'normal', fontSize: '14px' })).toBe(21)
    expect(lineHeightPx({ lineHeight: '', fontSize: '' })).toBe(21)
  })
})

describe('CSS da caixa — as medidas que a regra de altura supõe', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
  const block = (sel: string): string => {
    const i = css.indexOf(`${sel} {`)
    expect(i, sel).toBeGreaterThanOrEqual(0)
    return css.slice(i, css.indexOf('}', i))
  }
  it('linha de 21px (14px × 1.5) e 4,5px de padding em cima e embaixo, de uma variável só', () => {
    const base = block('.composer-input')
    expect(base).toMatch(/font-size: 14px;/)
    expect(base).toMatch(/line-height: 1\.5;/)
    expect(block('.composer-input-wrap')).toMatch(/--composer-pad-y: 4\.5px;/)
    expect(block('.composer-input-wrap .composer-input')).toMatch(/padding: var\(--composer-pad-y\) 0;/)
    expect(block('.composer-highlight')).toMatch(/padding: var\(--composer-pad-y\) 0;/)
  })
  it('piso de 1 linha inteira calculado das mesmas medidas (1lh + 2 × padding), sem px fixo', () => {
    const rule = block(".composer-input-wrap .composer-input[role='textbox']")
    expect(rule).toMatch(/min-height: calc\(1lh \+ 2 \* var\(--composer-pad-y\)\);/)
    expect(rule).not.toMatch(/min-height: \d/)
  })
  it('o piso do CSS resolvido com as medidas do arquivo é o piso do JS: 30px', () => {
    const fontSize = Number(/font-size: (\d+)px;/.exec(block('.composer-input'))?.[1])
    const lh = Number(/line-height: ([\d.]+);/.exec(block('.composer-input'))?.[1]) * fontSize
    const pad = Number(/--composer-pad-y: ([\d.]+)px;/.exec(block('.composer-input-wrap'))?.[1])
    const cssFloor = lh + 2 * pad // calc(1lh + 2 * var(--composer-pad-y))
    expect(cssFloor).toBe(30)
    expect(composerBoxHeight({ scrollHeight: pad * 2, lineHeight: lh, padY: pad * 2 }).height).toBe(cssFloor)
  })
  it('placeholder numa linha só, cortado com reticências', () => {
    const ph = block('.composer-highlight .composer-placeholder')
    expect(ph).toMatch(/white-space: nowrap;/)
    expect(ph).toMatch(/overflow: hidden;/)
    expect(ph).toMatch(/text-overflow: ellipsis;/)
  })
  it('miniatura inline e chip cabem na linha de 21px', () => {
    const px = (sel: string): number => Number(/height: (\d+)px;/.exec(block(sel))?.[1])
    expect(px('img.inline-att')).toBeLessThanOrEqual(LH)
    // bloco "img.inline-att-file, img.inline-att-ref, img.inline-att-pending {"
    expect(px('img.inline-att-pending')).toBeLessThanOrEqual(LH)
  })
})
