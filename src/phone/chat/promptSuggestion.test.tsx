/**
 * O chip da sugestão do próximo prompt no celular: só com a conversa parada; o
 * toque põe o texto no campo (vazio recebe o texto; com texto, entra no fim depois
 * de um espaço), nunca envia, e o chip some até o próximo turno.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { client } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import type { ConvSummary } from '../core/types'
import { ChatView } from './ChatView'
import { PromptSuggestionChip } from './PromptSuggestion'

const conv = (extra: Partial<ConvSummary> = {}): ConvSummary => ({ id: 'c1', title: 'Loja', cwd: '/p', busy: false, connected: true, updatedAt: 1, ...extra })
const LABEL = 'Usar a sugestão: rode os testes'

beforeEach(resetApp)
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PromptSuggestionChip (celular)', () => {
  it('parada e com sugestão: o chip; ocupada ou sem sugestão: nada', () => {
    const onUse = vi.fn()
    expect(render(<PromptSuggestionChip conv={conv({ suggestion: 'rode os testes', busy: true })} onUse={onUse} />).container.firstChild).toBeNull()
    expect(render(<PromptSuggestionChip conv={conv()} onUse={onUse} />).container.firstChild).toBeNull()
    const { getByLabelText } = render(<PromptSuggestionChip conv={conv({ suggestion: 'rode os testes' })} onUse={onUse} />)
    fireEvent.click(getByLabelText(LABEL))
    expect(onUse).toHaveBeenCalledExactlyOnceWith('rode os testes')
  })

  it('usada, some; depois de um turno a mesma sugestão vale de novo', () => {
    const onUse = vi.fn()
    const view = render(<PromptSuggestionChip conv={conv({ suggestion: 'rode os testes' })} onUse={onUse} />)
    fireEvent.click(view.getByLabelText(LABEL))
    expect(view.container.firstChild).toBeNull()
    view.rerender(<PromptSuggestionChip conv={conv({ suggestion: 'rode os testes', busy: true })} onUse={onUse} />)
    view.rerender(<PromptSuggestionChip conv={conv({ suggestion: 'rode os testes' })} onUse={onUse} />)
    expect(view.getByLabelText(LABEL)).toBeTruthy()
  })
})

describe('ChatView — o chip enche o campo sem enviar', () => {
  const open = (): ReturnType<typeof render> => {
    client.store.set({ conversations: [conv({ suggestion: 'rode os testes' })], convId: 'c1', messages: [], historyLoading: false, loaded: true })
    return render(<ChatView />)
  }

  it('caixa vazia recebe o texto', () => {
    const send = vi.spyOn(client, 'send')
    const { container, getByLabelText, queryByLabelText } = open()
    fireEvent.click(getByLabelText(LABEL))
    expect(container.querySelector('textarea')?.value).toBe('rode os testes')
    expect(queryByLabelText(LABEL)).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('com texto, a sugestão entra no fim, depois de um espaço', () => {
    const { container, getByLabelText } = open()
    const box = container.querySelector('textarea')!
    fireEvent.change(box, { target: { value: 'Revise o diff  ' } })
    fireEvent.click(getByLabelText(LABEL))
    expect(box.value).toBe('Revise o diff rode os testes')
  })
})
