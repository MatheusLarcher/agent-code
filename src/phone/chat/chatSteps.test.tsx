/**
 * O chat resumido no celular (o mesmo agrupamento do PC): na conversa, cada
 * resposta com a linha-resumo recolhida que abre só os cartões dela, girando com
 * "agora: …" no turno em andamento; na Central, cada comentário com a sua linha
 * (PC novo, `steps`) e o desenho de antes sem `steps` (PC antigo).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { RemoteCentralReply } from '@shared/central'
import { resetStepOpen } from '@renderer/components/useStepOpen'
import { client } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import { CentralReply } from '../central/CentralEntries'
import { centralUi } from '../central/centralStore'
import type { ChatMsg, ConvSummary } from '../core/types'
import { MessageList } from './MessageList'

const OK = { isError: false, text: 'ok' }
const tool = (id: string, name: string, input: unknown, done = true): ChatMsg =>
  ({ kind: 'tool-use', id, name, input, parentToolUseId: null, ...(done ? { result: OK } : {}) }) as ChatMsg
const say = (id: string, text: string, answer = false): ChatMsg => ({ kind: 'assistant-text', id, text, final: true, ...(answer ? { answer: true } : {}) }) as ChatMsg
const MSGS: ChatMsg[] = [
  { kind: 'user', id: 'u1', text: 'Corrige o Enviar' } as ChatMsg,
  say('a1', 'Vou procurar o campo.'),
  tool('g', 'Grep', { pattern: 'send-btn' }),
  tool('r', 'Read', { file_path: '/p/Composer.tsx' }),
  tool('td', 'TodoWrite', { todos: [] }), // plano: some no celular, como hoje
  say('a2', 'Achei a causa.'),
  tool('e', 'Edit', { file_path: '/p/Composer.tsx', old_string: 'a', new_string: 'b' }, false)
]

beforeEach(() => {
  resetApp()
  resetStepOpen()
  centralUi.set({ sent: [], busy: {}, picks: {}, why: {}, open: {}, tools: {}, replyTo: null })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('conversa no celular — resumo por resposta', () => {
  it('linha recolhida por resposta; o toque abre só os cartões dela; a última gira com "agora: …"', () => {
    const conv = { id: 'c1', title: 'Loja', cwd: '/p', busy: true, updatedAt: 1 } as ConvSummary
    client.store.set({ conversations: [conv], convId: 'c1', messages: MSGS, historyLoading: false, loaded: true })
    const { container } = render(<MessageList onRefresh={async () => undefined} />)
    const steps = [...container.querySelectorAll<HTMLElement>('.chat-step')]
    expect(steps).toHaveLength(2)
    expect(container.querySelector('.tool-card')).toBeNull()
    expect(steps[0].querySelector('.c-sum')?.textContent).toBe('Procurou "send-btn" · leu Composer.tsx')
    expect(steps[1].querySelector('.c-spin')).toBeTruthy()
    expect(steps[1].querySelector('.c-sum')?.textContent).toBe('agora: editando Composer.tsx…')
    fireEvent.click(steps[0].querySelector('.c-act')!)
    expect([...container.querySelectorAll('.tool-card .tool-name')].map((n) => n.textContent)).toEqual(['Grep', 'Read'])
    fireEvent.click(steps[0].querySelector('.c-act')!)
    expect(container.querySelector('.tool-card')).toBeNull()
  })
})

const base: RemoteCentralReply = {
  kind: 'reply',
  id: 'reply:r1',
  ts: 1,
  requestId: 'r1',
  anchor: { convId: 'c1', msgId: 'u1' },
  who: 'loja · Enviar',
  color: '#6f9bd1',
  notes: ['Vou procurar o campo.', 'Achei a causa.'],
  answer: 'Pronto.',
  activity: { segments: [{ text: 'Fez tudo' }], text: 'Fez tudo', count: 3, errors: 0, done: true }
}
const act = (text: string, count: number) => ({ segments: [{ text }], text, count, errors: 0 })

describe('Central no celular — steps opcional', () => {
  it('com steps: cada comentário com a sua linha; o toque carrega o turno e mostra só as ações do passo', async () => {
    vi.spyOn(client, 'request').mockResolvedValue({ messages: MSGS.concat(say('a3', 'Pronto.', true)) })
    const r: RemoteCentralReply = {
      ...base,
      steps: [
        { note: 'Vou procurar o campo.', activity: act('Procurou "send-btn" · leu Composer.tsx', 2), toolIds: ['g', 'r'] },
        { note: 'Achei a causa.', activity: act('Editou Composer.tsx +1 −1', 1), toolIds: ['e'] }
      ]
    }
    const { container } = render(<CentralReply r={r} />)
    const order = [...container.querySelector('.c-agent')!.children].map((el) => el.className.split(' ')[0])
    expect(order.filter((c) => c !== 'c-swipe-ic')).toEqual(['c-who', 'c-note', 'c-act', 'c-note', 'c-act', 'c-answer', 'c-open'])
    fireEvent.click(container.querySelectorAll<HTMLElement>('.c-act')[1])
    await waitFor(() => expect([...container.querySelectorAll('.tool-card .tool-name')].map((n) => n.textContent)).toEqual(['Edit']))
  })

  it('sem steps (PC antigo): o desenho de antes — notas e UMA linha do turno', () => {
    const { container } = render(<CentralReply r={base} />)
    expect(container.querySelectorAll('.c-note')).toHaveLength(2)
    expect(container.querySelectorAll('.c-act')).toHaveLength(1)
    expect(container.querySelector('.c-sum')?.textContent).toBe('Fez tudo')
  })
})

describe('Central no celular — janela das últimas', () => {
  it('as 60 do retrato: desenha as últimas 40 com o aviso das anteriores', async () => {
    const { CentralView } = await import('../central/CentralView')
    const { CENTRAL_CONV_ID } = await import('../core/client')
    const entries = Array.from({ length: 60 }, (_, i) => ({ kind: 'request', id: `r${i}`, ts: i, text: `pedido ${i}`, state: 'delivered' }))
    const central = { id: CENTRAL_CONV_ID, title: 'Central', cwd: '', updatedAt: 1, central: { entries, rail: [], questions: [] } } as unknown as ConvSummary
    client.store.set({ conversations: [central], loaded: true, convId: '' })
    const { container } = render(<CentralView />)
    const bubbles = [...container.querySelectorAll('.c-me .c-bubble')].map((b) => b.textContent)
    expect(bubbles).toHaveLength(40)
    expect(bubbles[0]).toBe('pedido 20')
    expect(container.querySelector('.load-more-hint')?.textContent).toBe('↑ Role para cima para carregar mais (20 anteriores)')
  })
})
