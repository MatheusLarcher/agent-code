import { describe, it, expect } from 'vitest'
import type { PickedElement } from '@shared/ipc'
import { serializeInline, type InlineAtt } from '../../inlineMedia/inlineAttachments'
import { fromDraft, toDraft } from '../../inlineMedia/draftMedia'
import { TOKEN } from '../../inlineMedia/editorModel'
import { formatElements, makeElementAtt } from './elementToken'

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

  it('sobrevive ao rascunho', () => {
    const att = makeElementAtt(el, 1)
    const d = toDraft(`a ${TOKEN}`, [att.id], new Map([[att.id, att]]))
    const back = fromDraft(d.text, d.media)
    expect(back.value).toBe(`a ${TOKEN}`)
    expect(back.atts[0]).toMatchObject({ kind: 'element', el })
  })
})
