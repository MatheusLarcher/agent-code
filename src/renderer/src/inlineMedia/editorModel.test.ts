import { describe, it, expect } from 'vitest'
import { offsetFromPoint, pointFromOffset, renderEditor, serializeEditor, tokenAtCaret, TOKEN } from './editorModel'

function token(id: string): HTMLElement {
  const img = document.createElement('img')
  img.setAttribute('data-att-id', id)
  return img
}

function editor(html?: string): HTMLDivElement {
  const el = document.createElement('div')
  if (html !== undefined) el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('editorModel — DOM do campo <-> texto serializado', () => {
  it('ida e volta: texto, anexos e quebras de linha', () => {
    const el = editor()
    const value = `analisa ${TOKEN} e\n${TOKEN}fim`
    renderEditor(el, value, ['a1', 'a2'], token)
    expect(el.querySelectorAll('img[data-att-id]')).toHaveLength(2)
    expect(serializeEditor(el)).toEqual({ value, order: ['a1', 'a2'] })
  })

  it('apagar o <img> (Backspace/Delete do navegador) tira o anexo da ordem', () => {
    const el = editor()
    renderEditor(el, `a${TOKEN}b${TOKEN}c`, ['x', 'y'], token)
    el.querySelector('img[data-att-id="x"]')!.remove()
    expect(serializeEditor(el)).toEqual({ value: `ab${TOKEN}c`, order: ['y'] })
  })

  it('TOKEN sem anexo e U+FFFC colado como texto somem; U+200B e outros invisíveis do usuário ficam', () => {
    const el = editor()
    renderEditor(el, `a${TOKEN}b`, [], token)
    expect(serializeEditor(el).value).toBe('ab')
    const el2 = editor('x￼y​z')
    expect(serializeEditor(el2)).toEqual({ value: 'xy​z', order: [] })
    const el3 = editor('a​b‌c‍d⁠e﻿f')
    expect(serializeEditor(el3).value).toBe('a​b‌c‍d⁠e﻿f')
  })

  it('linhas do Chromium: <br>, <div> de colagem e o "\\n" extra do fim', () => {
    expect(serializeEditor(editor('a<br>b')).value).toBe('a\nb')
    expect(serializeEditor(editor('a<br>')).value).toBe('a') // <br> final é só marcador
    expect(serializeEditor(editor('abc l1<div>l2</div>')).value).toBe('abc l1\nl2')
    expect(serializeEditor(editor('<div>a</div><div><br></div><div>b</div>')).value).toBe('a\n\nb')
    expect(serializeEditor(editor('depois\n\n')).value).toBe('depois\n') // Shift+Enter no fim
    const el = editor()
    renderEditor(el, 'linha\n', [], token)
    expect(el.textContent).toBe('linha\n\n')
    expect(serializeEditor(el).value).toBe('linha\n')
  })

  it('cursor: posição do DOM <-> índice no texto, contando cada anexo como 1', () => {
    const el = editor()
    renderEditor(el, `ab${TOKEN}cd`, ['t'], token)
    const img = el.querySelector('img')!
    // logo depois do anexo
    const after = { node: el, offset: Array.prototype.indexOf.call(el.childNodes, img) + 1 }
    expect(offsetFromPoint(el, after.node, after.offset)).toBe(3)
    // logo antes do anexo
    expect(offsetFromPoint(el, el, Array.prototype.indexOf.call(el.childNodes, img))).toBe(2)
    // dentro do texto "cd"
    expect(offsetFromPoint(el, img.nextSibling!, 1)).toBe(4)
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const p = pointFromOffset(el, n)
      expect(offsetFromPoint(el, p.node, p.offset)).toBe(n)
    }
  })

  it('anexo encostado no cursor (o que Backspace/Delete apagam)', () => {
    const el = editor()
    renderEditor(el, `a${TOKEN}b`, ['t'], token)
    expect(tokenAtCaret(el, 2)?.getAttribute('data-att-id')).toBe('t') // antes do cursor
    expect(tokenAtCaret(el, 1)?.getAttribute('data-att-id')).toBe('t') // depois do cursor
    expect(tokenAtCaret(el, 0)).toBeNull()
  })
})
