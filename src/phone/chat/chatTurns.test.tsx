/**
 * O visual novo do chat no celular: turno com trilho, linha "ao vivo" com o turno
 * rodando, animação só no conteúdo que chega depois de carregar (nunca no
 * histórico) e o composer sem Econ./Loop (o Rápido fica).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { resetStepOpen } from '@renderer/components/useStepOpen'
import { client } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import { ModelBar } from '../composer/ModelBar'
import type { ChatMsg, ConvSummary } from '../core/types'
import { ChatView } from './ChatView'
import { isPlainText } from './motion'
import { MessageList } from './MessageList'

const say = (id: string, text: string): ChatMsg => ({ kind: 'assistant-text', id, text, final: true }) as ChatMsg
const grep = (id: string, done = true): ChatMsg =>
  ({ kind: 'tool-use', id, name: 'Grep', input: { pattern: 'x' }, parentToolUseId: null, ...(done ? { result: { isError: false, text: 'ok' } } : {}) }) as ChatMsg
const HISTORY: ChatMsg[] = [
  { kind: 'user', id: 'u1', text: 'Corrige o Enviar', ts: 1 } as ChatMsg,
  say('a1', 'Vou procurar o campo.'),
  grep('g1')
]
const conv = (busy: boolean): ConvSummary => ({ id: 'c1', title: 'Loja', cwd: '/p', busy, updatedAt: 1, model: 'opus-5.5', fastModeAvailable: true }) as ConvSummary

beforeEach(() => {
  resetApp()
  resetStepOpen()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('chat do celular — turno e ao vivo', () => {
  it('as respostas do agente ficam num turno com trilho; a sua mensagem fica fora', () => {
    client.store.set({ conversations: [conv(false)], convId: 'c1', messages: HISTORY, historyLoading: false, loaded: true })
    const { container } = render(<MessageList onRefresh={async () => undefined} />)
    const turn = container.querySelector('.turn')!
    expect(turn.querySelector('.turn-model')?.textContent).toBe('opus-5.5')
    expect(turn.querySelectorAll('.turn-item .chat-step')).toHaveLength(1)
    expect(turn.querySelector('.msg.user')).toBeNull()
    expect(container.querySelector('.turn-item.live')).toBeNull()
  })

  it('turno rodando: a linha "ao vivo" no fim, com o "agora" da resposta em andamento', () => {
    client.store.set({ conversations: [conv(true)], convId: 'c1', messages: [...HISTORY, grep('g2', false)], historyLoading: false, loaded: true })
    const { container } = render(<MessageList onRefresh={async () => undefined} />)
    const items = container.querySelectorAll('.turn-rail > .turn-item')
    expect(items[items.length - 1].classList.contains('live')).toBe(true)
    expect(container.querySelector('.live-row .shimmer')?.textContent).toMatch(/^Procurando/)
  })

  it('o "■ parar" fica na linha ao vivo e para o turno; sem a faixa "trabalhando…" de baixo', () => {
    const stop = vi.spyOn(client, 'interrupt').mockResolvedValue(undefined)
    client.store.set({ conversations: [conv(true)], convId: 'c1', messages: HISTORY, historyLoading: false, loaded: true })
    const { container } = render(<ChatView />)
    expect(container.querySelector('.busy-bar')).toBeNull()
    expect(container.textContent).not.toMatch(/trabalhando…/)
    const btn = container.querySelector<HTMLButtonElement>('.turn-item.live .live-stop')!
    expect(btn.textContent).toBe('■ parar')
    fireEvent.click(btn)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('turno sem resposta: a linha ao vivo diz há quanto tempo, e o parar continua nela', () => {
    const stalled = { ...conv(true), stalledSince: Date.now() - 65_000 } as ConvSummary
    client.store.set({ conversations: [stalled], convId: 'c1', messages: HISTORY, historyLoading: false, loaded: true })
    const { container } = render(<MessageList onRefresh={async () => undefined} />)
    expect(container.querySelector('.turn-item.live.stalled .live-stalled')?.textContent).toMatch(/^Sem resposta há /)
    expect(container.querySelector('.live-stop')).toBeTruthy()
  })

  it('sem turno rodando não há parar', () => {
    client.store.set({ conversations: [conv(false)], convId: 'c1', messages: HISTORY, historyLoading: false, loaded: true })
    const { container } = render(<MessageList onRefresh={async () => undefined} />)
    expect(container.querySelector('.live-stop')).toBeNull()
  })

  it('anima só o que chega depois de carregar; o histórico aparece pronto', () => {
    client.store.set({ conversations: [conv(true)], convId: 'c1', messages: HISTORY, historyLoading: false, loaded: true })
    const { container } = render(<MessageList onRefresh={async () => undefined} />)
    expect(container.querySelector('.pop, .w')).toBeNull()
    act(() => client.store.set({ messages: [...HISTORY, say('a2', 'Achei a causa no Composer.')] }))
    const words = [...container.querySelectorAll('.blur-text .w')].map((w) => w.textContent)
    expect(words).toEqual(['Achei', 'a', 'causa', 'no', 'Composer.'])
    expect(container.querySelectorAll('.turn-item.pop')).toHaveLength(1)
  })

  it('Markdown não entra palavra a palavra (perderia a formatação)', () => {
    expect(isPlainText('Achei a causa.')).toBe(true)
    expect(isPlainText('Veja `Composer.tsx`')).toBe(false)
    expect(isPlainText('- item\n- outro')).toBe(false)
  })
})

describe('composer do celular — modos', () => {
  it('sem Econ. e Loop; o Rápido continua', () => {
    client.store.set({ conversations: [conv(false)], convId: 'c1', models: [{ id: 'opus-5.5', label: 'Opus 5.5' }] } as never)
    const { container } = render(<ModelBar />)
    const chips = [...container.querySelectorAll('.mode-chip')].map((b) => b.textContent?.trim())
    expect(chips).toEqual(['↯ Rápido'])
  })
})
