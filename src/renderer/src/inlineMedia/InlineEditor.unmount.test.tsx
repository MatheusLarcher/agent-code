import { createRef } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { InlineEditor, type EditorElement } from './InlineEditor'
import type { InlineAtt } from './inlineAttachments'

/** Campo desmontado: a fachada de textarea ainda pode ser chamada (rAF, troca de conversa) e não pode quebrar. */

afterEach(cleanup)

describe('InlineEditor desmontado', () => {
  it('value =, selectionStart/End e setSelectionRange depois do unmount não lançam (scanNow com o campo nulo)', () => {
    const editorRef = createRef<EditorElement | null>()
    const r = render(
      <InlineEditor value="abc" order={[]} atts={new Map<string, InlineAtt>()} editable editorRef={editorRef} onEdit={() => {}} />
    )
    const el = editorRef.current as EditorElement
    expect(el.value).toBe('abc')
    r.unmount()
    expect(() => {
      el.value = 'depois do unmount'
    }).not.toThrow()
    expect(() => el.setSelectionRange(1, 1)).not.toThrow()
    expect(() => [el.selectionStart, el.selectionEnd]).not.toThrow()
  })
})
