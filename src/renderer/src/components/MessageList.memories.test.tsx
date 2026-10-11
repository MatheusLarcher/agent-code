import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ContextTurnSummary } from '@shared/contextSnapshot'
import type { UIMessage } from '../types'
import { UiProvider } from '../ui/UiProvider'
import { MessageList } from './MessageList'

const turn: ContextTurnSummary = { convId: 'a', turnId: 't1', pc: 'teste', startedAt: 1, model: 'claude-opus-5-5', models: [], provider: 'claude', request: 'Pedido', blockCount: 1, totalBytes: 0, memoriesSent: ['regra.md'], complete: true }
const messages: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'Pedido' },
  { kind: 'assistant-text', id: 'answer', text: 'Resposta', final: true, turnIds: ['t1'], answer: true }
]
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Object.assign(window, { api: {
    getCacheInfo: vi.fn(async () => ({ memoriesDir: 'D:/mem' })),
    listContextTurns: vi.fn(async () => [turn]), readContextTurn: vi.fn(async () => null),
    onContextTurnsChanged: vi.fn(() => () => undefined)
  } })
})
afterEach(cleanup)
it('anexa a memória ao pedido correspondente dentro do histórico normal', async () => {
  render(<UiProvider><MessageList convId="a" messages={messages} busy={false} tts={{ speakingId: null, onToggleSpeak: () => undefined }} onRetry={() => undefined} /></UiProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /1 memória neste turno/ }))
  expect(screen.getByText('regra.md')).toBeTruthy()
  const card = document.querySelector('.chat-memory-card')!
  expect(card.closest('.message-list')).toBeTruthy()
  expect(card.previousElementSibling?.getAttribute('data-mid')).toBe('u1')
})
