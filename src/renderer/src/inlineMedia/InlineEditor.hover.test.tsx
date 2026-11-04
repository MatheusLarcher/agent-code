import { createRef } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { InlineEditor, type EditorElement } from './InlineEditor'
import { TOKEN } from './editorModel'
import { makePendingAtt, makeRefAtt, type InlineAtt } from './inlineAttachments'
import { fromDraft } from './draftMedia'

/** A prévia do hover não pode ficar presa quando o anexo sai do campo. */

afterEach(cleanup)

function setup(att: InlineAtt) {
  const editorRef = createRef<EditorElement | null>()
  const atts = new Map<string, InlineAtt>([[att.id, att]])
  const ui = (value: string, order: string[], map = atts) => (
    <InlineEditor value={value} order={order} atts={map} editable editorRef={editorRef} onEdit={() => {}} />
  )
  const r = render(ui(`oi ${TOKEN}`, [att.id]))
  const token = (): Element | null => document.querySelector(`img[data-att-id="${att.id}"]`)
  const tip = (): Element | null => document.querySelector('.inline-att-preview')
  return { r, ui, token, tip, atts }
}

describe('prévia do anexo no hover', () => {
  it('some quando o anexo é removido do campo (envio limpa o texto)', async () => {
    const att = makeRefAtt({ name: 'a.txt', path: 'C:\\a.txt', mediaType: 'text/plain', size: 3 })
    const { r, ui, token, tip } = setup(att)
    fireEvent.mouseOver(token()!)
    expect(tip()).not.toBeNull()
    await act(async () => {
      r.rerender(ui('', []))
      await Promise.resolve() // o MutationObserver avisa num microtask
    })
    expect(token()).toBeNull()
    expect(tip()).toBeNull()
  })

  it('some ao mexer o mouse para fora do anexo', () => {
    const att = makeRefAtt({ name: 'a.txt', path: 'C:\\a.txt', mediaType: 'text/plain', size: 3 })
    const { token, tip } = setup(att)
    fireEvent.mouseOver(token()!)
    expect(tip()).not.toBeNull()
    fireEvent.mouseMove(document.body)
    expect(tip()).toBeNull()
  })

  it('mostra o anexo atual: o "resolvendo" vira o arquivo pronto', () => {
    const pending = makePendingAtt('b.txt')
    const { r, ui, token, tip } = setup(pending)
    fireEvent.mouseOver(token()!)
    expect(tip()?.textContent).toContain('b.txt')
    const ready = { ...makeRefAtt({ name: 'b.txt', path: 'C:\\b.txt', mediaType: 'text/plain', size: 9 }), id: pending.id }
    act(() => {
      r.rerender(ui(`oi ${TOKEN}`, [pending.id], new Map([[pending.id, ready]])))
    })
    expect(tip()?.textContent).toContain('C:\\b.txt')
  })
})

describe('rascunho com item inválido', () => {
  it('não deixa {{midia:N}} preso no texto nem desloca os outros', () => {
    const ok = { kind: 'ref', name: 'b.txt', path: 'C:\\b.txt', mediaType: 'text/plain', size: 1 }
    const d = fromDraft('a {{midia:1}} b {{midia:2}} c {{midia:9}}', [{ kind: 'lixo' }, ok])
    expect(d.value).toBe(`a  b ${TOKEN} c {{midia:9}}`)
    expect(d.restore).toHaveLength(1)
    expect(d.restore[0]).toMatchObject({ kind: 'ref', path: 'C:\\b.txt' })
  })
})
