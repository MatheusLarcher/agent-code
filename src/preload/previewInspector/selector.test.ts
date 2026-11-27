// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_HTML,
  MAX_TEXT,
  buildSelector,
  captureElement,
  segmentFor,
  stableClasses,
  truncate,
  visibleText
} from './selector'

const $ = (sel: string): Element => document.querySelector(sel)!

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('selector do preview — segmentos', () => {
  it('prefere #id, depois classes estáveis, depois a tag', () => {
    document.body.innerHTML = `
      <div id="app"></div>
      <p class="intro destaque extra"></p>
      <span></span>`
    expect(segmentFor($('#app'))).toBe('#app')
    expect(segmentFor($('p'))).toBe('p.intro.destaque')
    expect(segmentFor($('span'))).toBe('span')
  })

  it('descarta classes geradas (CSS-in-JS, hash, sufixo __hash)', () => {
    document.body.innerHTML = '<a class="css-1x2y sc-abc emotion-9 jsx-12 _priv a1b2c3 btn__k3j9x2 botao"></a>'
    expect(stableClasses($('a'))).toEqual(['botao'])
  })

  it('usa nth-of-type só quando há irmãos com a mesma tag', () => {
    document.body.innerHTML = '<ul><li>a</li><li>b</li><li>c</li></ul><section><h2>x</h2></section>'
    expect(segmentFor(document.querySelectorAll('li')[1])).toBe('li:nth-of-type(2)')
    expect(segmentFor($('h2'))).toBe('h2')
  })

  it('escapa id e classe com caracteres especiais', () => {
    document.body.innerHTML = '<div id="a:b"></div><i class="w-1/2"></i>'
    const idSel = segmentFor($('div'))
    expect(document.querySelector(idSel)).toBe($('div'))
    const clsSel = segmentFor($('i'))
    expect(document.querySelector(clsSel)).toBe($('i'))
  })
})

describe('selector do preview — caminho', () => {
  it('para no primeiro ancestral com id', () => {
    document.body.innerHTML = '<main id="m"><div class="card"><button>ok</button></div></main>'
    expect(buildSelector($('button'))).toBe('#m > div.card > button')
  })

  it('sobe no máximo 4 níveis e nunca inclui body/html', () => {
    document.body.innerHTML = '<div><section><article><header><nav><a>x</a></nav></header></article></section></div>'
    const sel = buildSelector($('a'))
    expect(sel.split(' > ')).toHaveLength(4)
    expect(sel).toBe('article > header > nav > a')
    document.body.innerHTML = '<p>solto</p>'
    expect(buildSelector($('p'))).toBe('p')
  })

  it('o seletor gerado encontra o próprio elemento', () => {
    document.body.innerHTML = '<ul class="lista"><li>1</li><li><b>2</b></li></ul>'
    const target = document.querySelectorAll('li')[1].querySelector('b')!
    expect(document.querySelector(buildSelector(target))).toBe(target)
  })
})

describe('selector do preview — captura', () => {
  it('normaliza o texto e corta texto/html nos limites do contrato', () => {
    const long = 'palavra '.repeat(60)
    document.body.innerHTML = `<div id="x" class="a b">  ${long}  </div>`
    const cap = captureElement($('#x'))
    expect(cap.tagName).toBe('div')
    expect(cap.selector).toBe('#x')
    expect(cap.id).toBe('x')
    expect(cap.classes).toBe('a b')
    expect(cap.text.length).toBe(MAX_TEXT + 1)
    expect(cap.text.endsWith('…')).toBe(true)
    expect(cap.text.startsWith('palavra palavra')).toBe(true)
    expect(cap.html.length).toBe(MAX_HTML + 1)
    expect(cap.html.startsWith('<div id="x"')).toBe(true)
  })

  it('elemento sem id/classe devolve strings vazias e texto curto intacto', () => {
    document.body.innerHTML = '<em>\n  oi   mundo \n</em>'
    const cap = captureElement($('em'))
    expect(cap).toEqual({ tagName: 'em', selector: 'em', id: '', classes: '', text: 'oi mundo', html: '<em>\n  oi   mundo \n</em>' })
  })

  it('truncate e visibleText', () => {
    expect(truncate('abc', 3)).toBe('abc')
    expect(truncate('abcd', 3)).toBe('abc…')
    document.body.innerHTML = '<p> a\t\tb\n c </p>'
    expect(visibleText($('p'))).toBe('a b c')
  })
})
