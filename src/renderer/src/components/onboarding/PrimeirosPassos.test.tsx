import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EXEMPLOS, marcarPrimeirosPassos, PRIMEIROS_PASSOS_CHAVE, PrimeirosPassos, primeirosPassosFeito } from './PrimeirosPassos'

afterEach(() => {
  cleanup()
  localStorage.removeItem(PRIMEIROS_PASSOS_CHAVE)
})

describe('Primeiros passos', () => {
  it('conta conectada: passo 1 marcado e o exemplo vai para a caixa (sem enviar)', () => {
    const onExemplo = vi.fn()
    render(<PrimeirosPassos conectarConta={null} onExemplo={onExemplo} onPular={vi.fn()} />)
    expect(screen.getByText(/^Conta conectada\./)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: EXEMPLOS[1] }))
    expect(onExemplo).toHaveBeenCalledWith(EXEMPLOS[1])
  })

  it('sem conta: mostra o cartão de conectar e os exemplos ficam desligados', () => {
    render(<PrimeirosPassos conectarConta={<button>Conectar conta</button>} onExemplo={vi.fn()} onPular={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Conectar conta' })).toBeTruthy()
    expect((screen.getByRole('button', { name: EXEMPLOS[0] }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('cada módulo abre a aba certa das Configurações e ganha ✓', () => {
    localStorage.removeItem('agentcode.primeirosPassos.vistos')
    const abrir = vi.fn()
    render(<PrimeirosPassos conectarConta={null} onExemplo={vi.fn()} onPular={vi.fn()} onAbrirConfiguracoes={abrir} />)
    fireEvent.click(screen.getByRole('button', { name: 'Escolher a pasta' }))
    expect(abrir).toHaveBeenCalledWith('dados')
    fireEvent.click(screen.getByRole('button', { name: 'Ligar a voz' }))
    expect(abrir).toHaveBeenCalledWith('voz')
    fireEvent.click(screen.getByRole('button', { name: 'Ajustar memórias' }))
    expect(abrir).toHaveBeenCalledWith('geral')
    // conta (conectada) + dados + ajudantes + memórias = 4 marcas
    expect(screen.getAllByText('✓')).toHaveLength(4)
    localStorage.removeItem('agentcode.primeirosPassos.vistos')
  })

  it('pular chama o callback; a marca de feito fica guardada', () => {
    const onPular = vi.fn()
    render(<PrimeirosPassos conectarConta={null} onExemplo={vi.fn()} onPular={onPular} />)
    fireEvent.click(screen.getByRole('button', { name: 'Já sei usar, pular' }))
    expect(onPular).toHaveBeenCalled()
    expect(primeirosPassosFeito()).toBe(false)
    marcarPrimeirosPassos()
    expect(primeirosPassosFeito()).toBe(true)
  })
})
