import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StageEstimate, estimateSummary, estimateText, parseEstimativa } from './StageEstimate'

afterEach(cleanup)

describe('StageEstimate — texto', () => {
  it('estimateText: formatMinutos ou "—" (sem valor ou valor inválido)', () => {
    expect(estimateText(45)).toBe('45 min')
    expect(estimateText(200)).toBe('3 h 20 min')
    expect(estimateText(undefined)).toBe('—')
    expect(estimateText(0)).toBe('—')
    expect(estimateText(10_001)).toBe('—')
  })

  it('estimateSummary: total e quantas sem estimativa', () => {
    const e = (estimativa?: number) => ({ estimativa })
    expect(estimateSummary([e(120), e(80), e()] as never)).toBe('Total: 3 h 20 min · 1 sem estimativa')
    expect(estimateSummary([e(45)] as never)).toBe('Total: 45 min')
    expect(estimateSummary([e(), e()] as never)).toBe('Nenhuma etapa estimada')
  })

  it('parseEstimativa: vazio = null; só dígitos viram número; o resto é NaN', () => {
    expect(parseEstimativa('  ')).toBeNull()
    expect(parseEstimativa(' 90 ')).toBe(90)
    expect(parseEstimativa('1.5')).toBeNaN()
    expect(parseEstimativa('-3')).toBeNaN()
    expect(parseEstimativa('1h')).toBeNaN()
  })
})

describe('StageEstimate — edição', () => {
  function setup(minutos?: number) {
    const onSave = vi.fn()
    render(<StageEstimate minutos={minutos} titulo="Entregar" onSave={onSave} />)
    const open = (): HTMLInputElement => {
      fireEvent.click(screen.getByRole('button', { name: /^Estimativa de Entregar/ }))
      return screen.getByRole('textbox', { name: 'Estimativa de Entregar, em minutos' }) as HTMLInputElement
    }
    return { onSave, open }
  }

  it('Enter grava uma vez só (o blur que vem depois não regrava)', () => {
    const { onSave, open } = setup()
    const input = open()
    fireEvent.change(input, { target: { value: '15' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(15)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('o mesmo valor (ou vazio sem estimativa) não grava; Esc não grava', () => {
    const a = setup(30)
    fireEvent.keyDown(a.open(), { key: 'Enter' })
    cleanup()
    const b = setup()
    fireEvent.blur(b.open())
    const input = b.open()
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(a.onSave).not.toHaveBeenCalled()
    expect(b.onSave).not.toHaveBeenCalled()
  })

  it('vazio com estimativa remove (null); texto inválido segue como NaN para quem valida', () => {
    const { onSave, open } = setup(30)
    let input = open()
    fireEvent.change(input, { target: { value: 'dez' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSave).toHaveBeenLastCalledWith(Number.NaN)
    input = open()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSave).toHaveBeenLastCalledWith(null)
  })

  it('Enter e Esc devolvem o foco ao botão da estimativa (não cai no <body>)', () => {
    const { onSave, open } = setup()
    const name = 'Estimativa de Entregar: nenhuma. Editar'
    let input = open()
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '15' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledWith(15)
    expect(document.activeElement).toBe(screen.getByRole('button', { name }))
    input = open()
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(screen.getByRole('button', { name }))
  })

  it('sair do campo clicando em outro lugar grava e deixa o foco lá', () => {
    const onSave = vi.fn()
    render(
      <>
        <StageEstimate titulo="Entregar" onSave={onSave} />
        <button type="button">Outro</button>
      </>
    )
    fireEvent.click(screen.getByRole('button', { name: /^Estimativa de Entregar/ }))
    const input = screen.getByRole('textbox', { name: 'Estimativa de Entregar, em minutos' })
    fireEvent.change(input, { target: { value: '20' } })
    const other = screen.getByRole('button', { name: 'Outro' })
    act(() => other.focus())
    expect(onSave).toHaveBeenCalledWith(20)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.activeElement).toBe(other)
  })

  it('sem onSave: só o texto, sem botão', () => {
    render(<StageEstimate minutos={90} titulo="Entregar" />)
    expect(screen.getByText('1 h 30 min').tagName).toBe('SPAN')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
