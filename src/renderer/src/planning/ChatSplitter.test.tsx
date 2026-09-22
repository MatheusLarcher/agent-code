import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatSplitter } from './ChatSplitter'
import {
  CHAT_DEFAULT_W,
  CHAT_MIN_W,
  clampChatWidth,
  loadChatWidth,
  loadRoteiroCollapsed,
  maxChatWidth,
  saveChatWidth,
  saveRoteiroCollapsed
} from './paneSizes'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('paneSizes', () => {
  it('a largura do chat fica entre 320px e metade da área', () => {
    expect(clampChatWidth(100, 1200)).toBe(CHAT_MIN_W)
    expect(clampChatWidth(900, 1200)).toBe(600)
    expect(clampChatWidth(450, 1200)).toBe(450)
    // Área estreita: a metade seria < 320, e o mínimo vence.
    expect(clampChatWidth(500, 500)).toBe(CHAT_MIN_W)
    expect(maxChatWidth(500)).toBe(CHAT_MIN_W)
  })

  it('área ainda não medida só aplica o mínimo', () => {
    expect(maxChatWidth(0)).toBe(Infinity)
    expect(clampChatWidth(2000, 0)).toBe(2000)
  })

  it('padrão 380px; a largura escolhida volta na próxima sessão', () => {
    expect(loadChatWidth()).toBe(CHAT_DEFAULT_W)
    saveChatWidth(512.4)
    expect(loadChatWidth()).toBe(512)
    localStorage.setItem('agentcode.planning.chatWidth', 'lixo')
    expect(loadChatWidth()).toBe(CHAT_DEFAULT_W)
    localStorage.setItem('agentcode.planning.chatWidth', '90')
    expect(loadChatWidth()).toBe(CHAT_MIN_W)
  })

  it('roteiro recolhido é lembrado', () => {
    expect(loadRoteiroCollapsed()).toBe(false)
    saveRoteiroCollapsed(true)
    expect(loadRoteiroCollapsed()).toBe(true)
    saveRoteiroCollapsed(false)
    expect(loadRoteiroCollapsed()).toBe(false)
  })
})

function renderSplitter(width = 380, container = 1000) {
  const onResize = vi.fn()
  const onCommit = vi.fn()
  render(<ChatSplitter width={width} getContainerWidth={() => container} onResize={onResize} onCommit={onCommit} />)
  return { sep: screen.getByRole('separator', { name: 'Largura do chat' }), onResize, onCommit }
}

describe('ChatSplitter', () => {
  it('arrastar para a esquerda alarga o chat e o fim do arrasto grava', () => {
    const { sep, onResize, onCommit } = renderSplitter()
    fireEvent.pointerDown(sep, { clientX: 600, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 550, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(430)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.pointerUp(sep, { clientX: 550, pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(430)
  })

  it('o arrasto para no máximo (metade da área) e no mínimo (320px)', () => {
    const { sep, onResize, onCommit } = renderSplitter()
    fireEvent.pointerDown(sep, { clientX: 600, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: -400, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(500)
    fireEvent.pointerMove(sep, { clientX: 2000, pointerId: 1 })
    expect(onResize).toHaveBeenLastCalledWith(CHAT_MIN_W)
    fireEvent.pointerUp(sep, { pointerId: 1 })
    expect(onCommit).toHaveBeenCalledWith(CHAT_MIN_W)
  })

  it('mover sem ter apertado não redimensiona', () => {
    const { sep, onResize } = renderSplitter()
    fireEvent.pointerMove(sep, { clientX: 100, pointerId: 1 })
    expect(onResize).not.toHaveBeenCalled()
  })

  it('teclado: setas andam 16px; Home e End vão aos limites', () => {
    const { sep, onCommit } = renderSplitter(380, 1000)
    fireEvent.keyDown(sep, { key: 'ArrowLeft' })
    expect(onCommit).toHaveBeenLastCalledWith(396)
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(onCommit).toHaveBeenLastCalledWith(364)
    fireEvent.keyDown(sep, { key: 'End' })
    expect(onCommit).toHaveBeenLastCalledWith(500)
    fireEvent.keyDown(sep, { key: 'Home' })
    expect(onCommit).toHaveBeenLastCalledWith(CHAT_MIN_W)
  })

  it('anuncia a largura e os limites para leitor de tela', () => {
    const { sep } = renderSplitter(420, 1000)
    expect(sep.getAttribute('aria-valuenow')).toBe('420')
    expect(sep.getAttribute('aria-valuemin')).toBe(String(CHAT_MIN_W))
    expect(sep.getAttribute('aria-valuemax')).toBe('500')
  })
})
