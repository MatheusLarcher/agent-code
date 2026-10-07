/**
 * Voltar no Escritório: um passo por toque — o que está aberto por cima no 3D (o
 * mesmo Esc do PC: menu → tela focada, engine.leaveFocus), depois a faixa do agente
 * escolhido, depois a raiz (minimiza). Fora da aba, o Escritório não responde.
 * O 3D é trocado por um motor de mentira que ouve o Esc como o de verdade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { client } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import type { ConvSummary } from '../core/types'
import { handleBack } from '../shell/backButton'
import { escapeOffice, OfficeTab } from './OfficeTab'

const engine = vi.hoisted(() => ({ focused: false, menu: false, leaveFocus: 0 }))

vi.mock('@renderer/office3d/Office3DWorkspace', async () => {
  const { useEffect } = await import('react')
  return {
    Office3DWorkspace({ onOpenConversation }: { onOpenConversation: (id: string) => void }): JSX.Element {
      useEffect(() => {
        // O menu do monitor: captura na janela e para a propagação (como o ProjectFilter, sem preventDefault).
        const menu = (e: KeyboardEvent): void => {
          if (e.key !== 'Escape' || !engine.menu) return
          e.stopPropagation()
          engine.menu = false
        }
        // O motor (pointerInput.bindKeys): Esc com uma tela focada → leaveFocus(true, true) + preventDefault.
        const keys = (e: KeyboardEvent): void => {
          if (e.key !== 'Escape' || !engine.focused) return
          engine.focused = false
          engine.leaveFocus++
          e.preventDefault()
        }
        window.addEventListener('keydown', menu, true)
        window.addEventListener('keydown', keys)
        return () => {
          window.removeEventListener('keydown', menu, true)
          window.removeEventListener('keydown', keys)
        }
      }, [])
      return (
        <button
          type="button"
          onClick={() => {
            engine.focused = true
            onOpenConversation('a1')
          }}
        >
          agente
        </button>
      )
    }
  }
})

describe('voltar no Escritório', () => {
  beforeEach(() => {
    resetApp()
    Object.assign(engine, { focused: false, menu: false, leaveFocus: 0 })
    client.store.set({ conversations: [{ id: 'a1', title: 'Loja', cwd: 'C:/proj/loja', updatedAt: 1 } as ConvSummary] })
  })
  afterEach(() => cleanup())

  it('menu → tela focada → faixa do agente → raiz, um passo por toque', () => {
    render(<OfficeTab active />)
    fireEvent.click(screen.getByText('agente'))
    engine.menu = true
    expect(screen.getByText('Loja')).toBeTruthy()
    act(() => void handleBack())
    expect([engine.menu, engine.focused]).toEqual([false, true])
    act(() => void handleBack())
    expect(engine.focused).toBe(false)
    expect(engine.leaveFocus).toBe(1)
    expect(screen.getByText('Loja')).toBeTruthy()
    act(() => void handleBack())
    expect(screen.queryByText('Loja')).toBeNull()
    let root = false
    act(() => {
      root = !handleBack()
    })
    expect(root).toBe(true)
  })

  it('fora da aba o Escritório não segura o voltar', () => {
    const { rerender } = render(<OfficeTab active />)
    fireEvent.click(screen.getByText('agente'))
    rerender(<OfficeTab active={false} />)
    expect(handleBack()).toBe(false)
    expect(engine.leaveFocus).toBe(0)
  })

  it('escapeOffice: sem ninguém ouvindo, não consome', () => {
    expect(escapeOffice()).toBe(false)
  })
})
