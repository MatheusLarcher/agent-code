import { describe, it, expect } from 'vitest'
import type { PickedElement } from '@shared/ipc'
import { serializeInline, type InlineAtt } from '../../inlineMedia/inlineAttachments'
import { fromDraft, toDraft } from '../../inlineMedia/draftMedia'
import { TOKEN } from '../../inlineMedia/editorModel'
import { bubbleElements, formatElements, makeElementAtt, parseElementsBlock } from './elementToken'

const el: PickedElement = {
  selector: '#login', tagName: 'button', id: 'login', classes: 'btn', text: 'Entrar', html: '<button id="login">Entrar</button>',
  url: 'https://x.test', tabId: 't1', tabName: 'web - X'
}

describe('elemento marcado como bloco inline', () => {
  it('vira "[elemento N]" no ponto do texto e segue em `elements`', () => {
    const att = makeElementAtt(el, 1)
    const atts = new Map<string, InlineAtt>([[att.id, att]])
    const out = serializeInline(`clique em ${TOKEN} agora`, [att.id], atts)
    expect(out.text).toBe('clique em [elemento 1] agora')
    expect(out.elements).toEqual([el])
    expect(out.images).toEqual([])
  })

  it('os detalhes levam o mesmo número', () => {
    const s = formatElements([el])
    expect(s).toContain('[elemento 1] button#login · aba: web - X')
    expect(s).toContain('selector: #login')
  })

  it('a bolha lê de volta o bloco de dois elementos', () => {
    const cta: PickedElement = {
      ...el, selector: '#m > button.cta', id: '', classes: 'cta big', text: 'Comprar',
      html: '<button class="cta  big" type="button">Comprar</button>', tabName: 'Preview'
    }
    const full = `veja [elemento 1] e [elemento 2]\n\n${formatElements([el, cta])}`
    const out = parseElementsBlock(full)
    expect(out).toEqual([
      { n: 1, tag: 'button', id: 'login', classes: '', tab: 'web - X', selector: '#login', text: 'Entrar', html: '<button id="login">Entrar</button>' },
      { n: 2, tag: 'button', id: '', classes: 'cta big', tab: 'Preview', selector: '#m > button.cta', text: 'Comprar', html: cta.html }
    ])
    expect(bubbleElements(full)).toEqual({ elements: out })
  })

  it('sem bloco de elementos: nada para a bolha', () => {
    expect(parseElementsBlock('só um texto com [elemento 1] escrito à mão')).toEqual([])
    expect(bubbleElements('oi')).toEqual({})
  })

  it('html e texto com quebra de linha não confundem o próximo elemento', () => {
    const card: PickedElement = {
      ...el, selector: 'div.card', tagName: 'div', id: 'c1', text: 'Plano\nAnual', html: '<div class="card">\n  <h2>Plano</h2>\n\n  <p>Anual</p>\n</div>'
    }
    const out = parseElementsBlock(`x\n\n${formatElements([card, el])}`)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ n: 1, tag: 'div', id: 'c1', classes: 'card', text: 'Plano\nAnual', html: card.html })
    expect(out[1]).toMatchObject({ n: 2, id: 'login', selector: '#login' })
  })

  it('sobrevive ao rascunho', () => {
    const att = makeElementAtt(el, 1)
    const d = toDraft(`a ${TOKEN}`, [att.id], new Map([[att.id, att]]))
    const back = fromDraft(d.text, d.media)
    expect(back.value).toBe(`a ${TOKEN}`)
    expect(back.atts[0]).toMatchObject({ kind: 'element', el })
  })
})
