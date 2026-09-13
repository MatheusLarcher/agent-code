import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { VigiaChip } from './VigiaChip'

afterEach(cleanup)

const PERGUNTA = 'Qual é o diâmetro real do eixo da extrusora?'

function setup(options?: string[]) {
  const onAnswer = vi.fn()
  const onDismiss = vi.fn()
  render(<VigiaChip question={PERGUNTA} options={options} onAnswer={onAnswer} onDismiss={onDismiss} />)
  const box = screen.getByRole('textbox') as HTMLTextAreaElement
  return { onAnswer, onDismiss, box }
}

describe('VigiaChip', () => {
  // O ponto do recurso: a pergunta é PARA O USUÁRIO e ele responde ali mesmo —
  // nada de perguntar a ele se é para perguntar ao agente.
  it('mostra a pergunta e o campo de resposta de cara, sem precisar abrir', () => {
    const { box } = setup()
    expect(screen.getByText(PERGUNTA)).toBeTruthy()
    expect(box).toBeTruthy()
  })

  it('responder entrega o texto digitado', () => {
    const { onAnswer, box } = setup()
    fireEvent.change(box, { target: { value: '11,9 mm, medido com paquímetro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }))
    expect(onAnswer).toHaveBeenCalledWith('11,9 mm, medido com paquímetro')
  })

  it('Enter envia; Shift+Enter não', () => {
    const { onAnswer, box } = setup()
    fireEvent.change(box, { target: { value: '11,9 mm' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onAnswer).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith('11,9 mm')
  })

  // Resposta em branco não vira mensagem para o agente.
  it('não envia resposta vazia', () => {
    const { onAnswer, box } = setup()
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAnswer).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Responder' }).hasAttribute('disabled')).toBe(true)
  })

  it('dispensar não manda nada ao agente', () => {
    const { onAnswer, onDismiss } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }))
    expect(onDismiss).toHaveBeenCalled()
    expect(onAnswer).not.toHaveBeenCalled()
  })
})

// Os atalhos de clique, no mesmo molde do AskUserQuestion do agente: escolher
// uma resposta OU digitar a sua — nunca as duas ao mesmo tempo.
describe('VigiaChip — respostas prováveis', () => {
  const OPCOES = ['12 mm', '11,9 mm']

  it('sem opções, só o campo de texto', () => {
    setup()
    expect(screen.queryByRole('group', { name: 'Respostas prováveis' })).toBeNull()
  })

  it('clicar numa opção e responder entrega o texto dela', () => {
    const { onAnswer } = setup(OPCOES)
    fireEvent.click(screen.getByRole('button', { name: '12 mm' }))
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }))
    expect(onAnswer).toHaveBeenCalledWith('12 mm')
  })

  // Duas respostas com uma regra implícita de precedência seria pior do que
  // perder a escolha: aqui digitar desfaz o clique, e vice-versa.
  it('digitar desfaz a opção escolhida; escolher apaga o que foi digitado', () => {
    const { onAnswer, box } = setup(OPCOES)
    fireEvent.click(screen.getByRole('button', { name: '12 mm' }))
    fireEvent.change(box, { target: { value: '11,85 mm medido' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onAnswer).toHaveBeenCalledWith('11,85 mm medido')

    onAnswer.mockClear()
    fireEvent.click(screen.getByRole('button', { name: '11,9 mm' }))
    expect(box.value).toBe('')
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }))
    expect(onAnswer).toHaveBeenCalledWith('11,9 mm')
  })

  it('sem escolha nem texto, Responder fica travado', () => {
    setup(OPCOES)
    expect(screen.getByRole('button', { name: 'Responder' }).hasAttribute('disabled')).toBe(true)
  })
})
