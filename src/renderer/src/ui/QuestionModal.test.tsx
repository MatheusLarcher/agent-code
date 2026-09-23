import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { PermissionRequest } from '@shared/ipc'
import { QuestionModal } from './QuestionModal'

afterEach(cleanup)

function makeRequest(): PermissionRequest {
  return {
    id: 'req1',
    toolName: 'AskUserQuestion',
    input: {},
    questions: [
      {
        header: 'Abordagem',
        question: 'Qual caminho seguir?',
        multiSelect: false,
        options: [
          { label: 'A', description: 'Opção A' },
          { label: 'B', description: 'Opção B' }
        ]
      }
    ]
  }
}

describe('QuestionModal — clicar fora ou Esc minimiza, não cancela', () => {
  it('clicar no overlay (fora do card) chama onMinimize, nunca onCancel', () => {
    const onMinimize = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(
      <QuestionModal request={makeRequest()} onAnswer={vi.fn()} onCancel={onCancel} onMinimize={onMinimize} />
    )
    const overlay = container.querySelector('.modal-overlay')!
    fireEvent.click(overlay)
    expect(onMinimize).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('clicar dentro do card (na pergunta) NÃO minimiza nem cancela (stopPropagation)', () => {
    const onMinimize = vi.fn()
    const onCancel = vi.fn()
    render(<QuestionModal request={makeRequest()} onAnswer={vi.fn()} onCancel={onCancel} onMinimize={onMinimize} />)
    fireEvent.click(screen.getByText('Qual caminho seguir?'))
    expect(onMinimize).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('qualquer clique dentro do card renova o prazo (onActivity); clicar fora não', () => {
    const onActivity = vi.fn()
    const { container } = render(
      <QuestionModal request={makeRequest()} onAnswer={vi.fn()} onCancel={vi.fn()} onMinimize={vi.fn()} onActivity={onActivity} />
    )
    fireEvent.pointerDown(screen.getByText('Qual caminho seguir?'))
    fireEvent.pointerDown(screen.getByText('Opção B'))
    expect(onActivity).toHaveBeenCalledTimes(2)
    fireEvent.pointerDown(container.querySelector('.modal-overlay')!)
    expect(onActivity).toHaveBeenCalledTimes(2)
  })

  it('Esc chama onMinimize, nunca onCancel', () => {
    const onMinimize = vi.fn()
    const onCancel = vi.fn()
    render(<QuestionModal request={makeRequest()} onAnswer={vi.fn()} onCancel={onCancel} onMinimize={onMinimize} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onMinimize).toHaveBeenCalledTimes(1)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('só o botão "Cancelar" chama onCancel (e não onMinimize)', () => {
    const onMinimize = vi.fn()
    const onCancel = vi.fn()
    render(<QuestionModal request={makeRequest()} onAnswer={vi.fn()} onCancel={onCancel} onMinimize={onMinimize} />)
    fireEvent.click(screen.getByText('Cancelar'))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onMinimize).not.toHaveBeenCalled()
  })

  it('escolher uma opção e responder chama onAnswer com o pick', () => {
    const onAnswer = vi.fn()
    render(<QuestionModal request={makeRequest()} onAnswer={onAnswer} onCancel={vi.fn()} onMinimize={vi.fn()} />)
    fireEvent.click(screen.getByText('A'))
    fireEvent.click(screen.getByText('Responder'))
    expect(onAnswer).toHaveBeenCalledWith([
      { header: 'Abordagem', question: 'Qual caminho seguir?', selected: ['A'] }
    ])
  })
})
