import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatOpacityControl } from './ChatOpacityControl'
import { CHAT_OPACITY_KEY, clampChatOpacity, reloadChatOpacityForTest, setChatOpacity } from '../chatOpacity'

const alpha = (): string => document.documentElement.style.getPropertyValue('--chat-bg-alpha')

afterEach(() => {
  cleanup()
  localStorage.clear()
  reloadChatOpacityForTest()
})

describe('transparência do fundo dos chats', () => {
  it('o slider altera a variável CSS única e grava a escolha', () => {
    render(<ChatOpacityControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Transparência do chat' }))
    const slider = screen.getByLabelText('Opacidade do fundo') as HTMLInputElement
    expect(slider.value).toBe('100')
    fireEvent.change(slider, { target: { value: '60' } })
    expect(alpha()).toBe('0.6')
    expect(localStorage.getItem(CHAT_OPACITY_KEY)).toBe('60')
    expect(screen.getByText('60%')).toBeTruthy()
  })

  it('restaura o valor gravado ao reabrir', () => {
    localStorage.setItem(CHAT_OPACITY_KEY, '45')
    expect(reloadChatOpacityForTest()).toBe(45)
    expect(alpha()).toBe('0.45')
    render(<ChatOpacityControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Transparência do chat' }))
    expect((screen.getByLabelText('Opacidade do fundo') as HTMLInputElement).value).toBe('45')
  })

  it('limita entre 30 e 100 e ignora lixo', () => {
    expect(clampChatOpacity(5)).toBe(30)
    expect(clampChatOpacity(250)).toBe(100)
    expect(clampChatOpacity('abc')).toBe(100)
    setChatOpacity(1)
    expect(alpha()).toBe('0.3')
    localStorage.setItem(CHAT_OPACITY_KEY, 'lixo')
    expect(reloadChatOpacityForTest()).toBe(100)
  })

  it('Esc fecha o popover', () => {
    render(<ChatOpacityControl />)
    const btn = screen.getByRole('button', { name: 'Transparência do chat' })
    fireEvent.click(btn)
    fireEvent.keyDown(screen.getByLabelText('Opacidade do fundo'), { key: 'Escape' })
    expect(screen.queryByLabelText('Opacidade do fundo')).toBeNull()
    expect(btn.getAttribute('aria-expanded')).toBe('false')
  })

  it('os três tipos de chat usam a mesma variável', () => {
    const src = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')
    expect(src('styles.css')).toMatch(/\.chat-panel \{[^}]*--chat-bg-alpha/)
    expect(src('planning/planningChat.css')).toMatch(/\.pl-chat-float \{[^}]*--pl-chat-fill: calc\(78% \* var\(--chat-bg-alpha/)
    expect(src('office3d/screens.css')).toMatch(/\.o3d-chat-screen \{[^}]*--chat-bg-alpha/)
  })
})
