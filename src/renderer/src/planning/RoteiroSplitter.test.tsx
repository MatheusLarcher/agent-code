import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RoteiroSplitter } from './RoteiroSplitter'
import {
  ROTEIRO_DEFAULT_W,
  ROTEIRO_MIN_W,
  clampRoteiroWidth,
  loadChatMinimized,
  loadRoteiroCollapsed,
  loadRoteiroWidth,
  maxRoteiroWidth,
  saveChatMinimized,
  saveRoteiroCollapsed,
  saveRoteiroWidth
} from './paneSizes'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('paneSizes', () => {
  it('a largura do roteiro fica entre 180px e 40% da área', () => {
    expect(ROTEIRO_MIN_W).toBe(180)
    expect(clampRoteiroWidth(100, 1200)).toBe(180)
    expect(clampRoteiroWidth(900, 1200)).toBe(480)
    expect(clampRoteiroWidth(300, 1200)).toBe(300)
    // Área estreita: 40% seria < 180, e o mínimo vence.
    expect(clampRoteiroWidth(300, 400)).toBe(180)
    expect(maxRoteiroWidth(400)).toBe(180)
  })

  it('área ainda não medida só aplica o mínimo', () => {
    expect(maxRoteiroWidth(0)).toBe(Infinity)
    expect(clampRoteiroWidth(2000, 0)).toBe(2000)
  })

  it('padrão 220px; a largura escolhida volta na próxima sessão', () => {
    expect(loadRoteiroWidth()).toBe(ROTEIRO_DEFAULT_W)
    expect(ROTEIRO_DEFAULT_W).toBe(220)
    saveRoteiroWidth(312.4)
    expect(loadRoteiroWidth()).toBe(312)
    localStorage.setItem('agentcode.planning.roteiroWidth', 'lixo')
    expect(loadRoteiroWidth()).toBe(ROTEIRO_DEFAULT_W)
    localStorage.setItem('agentcode.planning.roteiroWidth', '90')
    expect(loadRoteiroWidth()).toBe(ROTEIRO_MIN_W)
  })

  it('roteiro recolhido é lembrado', () => {
    expect(loadRoteiroCollapsed()).toBe(false)
    saveRoteiroCollapsed(true)
    expect(loadRoteiroCollapsed()).toBe(true)
    saveRoteiroCollapsed(false)
    expect(loadRoteiroCollapsed()).toBe(false)
  })

  it('chat minimizado é lembrado; o padrão é maximizado', () => {
    expect(loadChatMinimized()).toBe(false)
    saveChatMinimized(true)
    expect(loadChatMinimized()).toBe(true)
    saveChatMinimized(false)
    expect(loadChatMinimized()).toBe(false)
  })
})

function renderSplitter(width = 220, container = 1000) {
  const onResize = vi.fn()
  const onCommit = vi.fn()
  render(<RoteiroSplitter width={width} getContainerWidth={() => container} onResize={onResize} onCommit={onCommit} />)
  return { sep: screen.getByRole('separator', { name: 'Largura do roteiro' }), onResize, onCommit }
}

describe('RoteiroSplitter', () => {
  it('arrastar para a direita alarga o roteiro e o fim do arrasto grava', () => {
    const { sep, onResize, onCommit } = renderSplitter()
    fireEvent.pointerDown(sep, { clientX: 220, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 290, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(290)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(sep, { clientX: 290, pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(290)
  })

  it('o arrasto para no máximo (40% da área) e no mínimo (180px)', () => {
    const { sep, onResize, onCommit } = renderSplitter()
    fireEvent.pointerDown(sep, { clientX: 220, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 2000, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(400)
    fireEvent.pointerMove(sep, { clientX: -500, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(ROTEIRO_MIN_W)
    fireEvent.pointerUp(sep, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(ROTEIRO_MIN_W)
  })

  it('mover sem ter apertado não redimensiona; botão direito não começa arrasto', () => {
    const { sep, onResize } = renderSplitter()
    fireEvent.pointerMove(sep, { clientX: 100, pointerId: 1 })
    fireEvent.pointerDown(sep, { clientX: 220, button: 2, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 300, pointerId: 1 })
    expect(onResize).not.toHaveBeenCalled()
  })

  it('teclado: setas andam 16px; Home e End vão aos limites', () => {
    const { sep, onCommit } = renderSplitter(220, 1000)
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenLastCalledWith(236)
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(204)
    fireEvent.keyDown(sep, { key: 'End' })
    expect(onCommit).toHaveBeenLastCalledWith(400)
    fireEvent.keyDown(sep, { key: 'Home' })
    expect(onCommit).toHaveBeenLastCalledWith(ROTEIRO_MIN_W)
    onCommit.mockClear()
    fireEvent.keyDown(sep, { key: 'a' })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('anuncia a largura e os limites para leitor de tela', () => {
    const { sep } = renderSplitter(260, 1000)
    expect(sep.getAttribute('aria-orientation')).toBe('vertical')
    expect(sep.getAttribute('aria-valuenow')).toBe('260')
    expect(sep.getAttribute('aria-valuemin')).toBe(String(ROTEIRO_MIN_W))
    expect(sep.getAttribute('aria-valuemax')).toBe('400')
    expect(sep.getAttribute('tabindex')).toBe('0')
  })
})
