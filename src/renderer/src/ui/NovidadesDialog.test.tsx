import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import novidades from '@shared/novidades.json'
import { fmtData, NovidadesDialog } from './NovidadesDialog'

afterEach(cleanup)

const NOTAS = [
  { versao: '0.1.2', data: '2026-11-19', itens: ['Botão novo de copiar.'] },
  { versao: '0.1.1', data: '2026-11-18', itens: ['Correção no Parar.', 'App mais leve.'] }
]

describe('NovidadesDialog', () => {
  it('lista as versões, marca a sua e formata a data', () => {
    render(<NovidadesDialog appVersion="0.1.2" onClose={() => {}} notas={NOTAS} />)
    expect(screen.getByRole('dialog', { name: 'Novidades' })).toBeTruthy()
    expect(screen.getByText('Versão 0.1.2')).toBeTruthy()
    expect(screen.getByText('Sua versão')).toBeTruthy()
    expect(screen.getByText('App mais leve.')).toBeTruthy()
    expect(screen.getByText('19 de nov. de 2026')).toBeTruthy()
  })

  it('Esc fecha só as Novidades, sem chegar ao modal de trás', () => {
    const onClose = vi.fn()
    const outro = vi.fn()
    window.addEventListener('keydown', outro)
    render(<NovidadesDialog appVersion="0.1.2" onClose={onClose} notas={NOTAS} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    window.removeEventListener('keydown', outro)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(outro).not.toHaveBeenCalled()
  })

  it('fmtData devolve o texto original quando não é data', () => {
    expect(fmtData('ontem')).toBe('ontem')
  })

  it('o arquivo de novidades tem formato válido', () => {
    expect(Array.isArray(novidades.proxima)).toBe(true)
    for (const v of novidades.versoes) {
      expect(v.versao).toMatch(/^\d+\.\d+\.\d+$/)
      expect(v.data).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(v.itens.length).toBeGreaterThan(0)
    }
  })
})
