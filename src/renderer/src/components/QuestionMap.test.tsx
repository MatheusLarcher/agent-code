import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from '../types'
import { QuestionMap } from './QuestionMap'

afterEach(cleanup)

describe('QuestionMap', () => {
  it('mostra apenas perguntas do usuário e navega para a escolhida', () => {
    const onSelect = vi.fn()
    const messages: UIMessage[] = [
      { kind: 'user', id: 'q1', text: 'Como funciona a fila?' },
      { kind: 'assistant-text', id: 'a1', text: 'Resposta', final: true },
      { kind: 'user', id: 'q2', text: 'E no Android?', ts: 1_700_000_000_000 }
    ]
    render(<QuestionMap messages={messages} scrollRatio={0} onSelect={onSelect} />)
    expect(screen.getAllByRole('button')).toHaveLength(2)
    fireEvent.mouseEnter(screen.getByLabelText('E no Android?'))
    fireEvent.click(screen.getByText('E no Android?'))
    expect(onSelect).toHaveBeenCalledWith('q2')
  })

  it('agrupa perguntas muito próximas sem perder o acesso a cada uma', () => {
    const onSelect = vi.fn()
    const messages: UIMessage[] = Array.from({ length: 100 }, (_, index) =>
      index === 10 || index === 11
        ? { kind: 'user', id: `q${index}`, text: `Pergunta ${index}` }
        : { kind: 'assistant-text', id: `a${index}`, text: 'Resposta', final: true }
    )
    render(<QuestionMap messages={messages} scrollRatio={0.1} onSelect={onSelect} />)
    const group = screen.getByLabelText('2 perguntas')
    fireEvent.mouseEnter(group)
    fireEvent.click(screen.getByText('Pergunta 11'))
    expect(onSelect).toHaveBeenCalledWith('q11')
  })
})
