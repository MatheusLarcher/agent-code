/**
 * O visual novo do chat no celular: turno com trilho, linha "ao vivo" com o turno
 * rodando, animação só no conteúdo que chega depois de carregar (nunca no
 * histórico) e o composer sem Econ./Loop (o Rápido fica).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { resetStepOpen } from '@renderer/components/useStepOpen'
import { client, toasts } from '../app/runtime'
import { resetApp } from '../app/testSupport'
import { ModelBar } from '../composer/ModelBar'
import type { ChatMsg, ConvSummary } from '../core/types'
import { ChatView } from './ChatView'
import { isPlainText } from './motion'
import { MessageItem, thinkingPreview } from './MessageItem'
import { MessageList } from './MessageList'

const say = (id: string, text: string): ChatMsg => ({ kind: 'assistant-text', id, text, final: true }) as ChatMsg
const grep = (id: string, done = true, ts?: number): ChatMsg =>
  ({ kind: 'tool-use', id, name: 'Grep', input: { pattern: 'x' }, parentToolUseId: null, ...(ts ? { ts } : {}), ...(done ? { result: { isError: false, text: 'ok' } } : {}) }) as ChatMsg
const think = (id: string, text: string, final = true): ChatMsg => ({ kind: 'thinking', id, text, final }) as ChatMsg
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

  it('compactando: a linha ao vivo vira o aviso, com o loading em modo compactar no trilho', () => {
    const compacting = { ...conv(true), compactingSince: Date.now() - 4_000 } as ConvSummary
    client.store.set({ conversations: [compacting], convId: 'c1', messages: HISTORY, historyLoading: false, loaded: true })
    const { container } = render(<MessageList onRefresh={async () => undefined} />)
    const live = container.querySelector('.turn-item.live.compacting')!
    expect(live.querySelector('.live-compacting')?.textContent).toBe('Compactando a conversa…')
    expect(live.querySelector('.live-loader.chat-live-loader.compacting')?.getAttribute('aria-hidden')).toBe('true')
    expect(live.querySelector('.live-t')?.textContent).toBe('4s')
    expect(live.querySelector('.shimmer')).toBeNull()
  })

  it('nova tentativa da API: a linha ao vivo diz o motivo e o prazo; vence o compactando, perde para o "sem resposta"', () => {
    const apiRetry = { attempt: 3, maxRetries: 10, retryAt: Date.now() + 12_000, status: 529, error: 'overloaded' }
    const retrying = { ...conv(true), apiRetry, compactingSince: Date.now() - 1_000 } as ConvSummary
    client.store.set({ conversations: [retrying], convId: 'c1', messages: HISTORY, historyLoading: false, loaded: true })
    const { container, unmount } = render(<MessageList onRefresh={async () => undefined} />)
    const live = container.querySelector('.turn-item.live.retrying')!
    expect(live.querySelector('.live-retry')?.textContent).toMatch(/^API sobrecarregada · nova tentativa em 1[12] s \(3\/10\)$/)
    expect(container.querySelector('.turn-item.live.compacting')).toBeNull()
    expect(live.querySelector('.live-stop')).toBeTruthy()
    unmount()
    const both = { ...retrying, stalledSince: Date.now() - 65_000 } as ConvSummary
    client.store.set({ conversations: [both], convId: 'c1' })
    const again = render(<MessageList onRefresh={async () => undefined} />).container
    expect(again.querySelector('.turn-item.live.stalled')).toBeTruthy()
    expect(again.querySelector('.live-retry')).toBeNull()
  })

  it('turno normal: o loading criativo no trilho (sem o modo compactar); "sem resposta" vence o compactando', () => {
    client.store.set({ conversations: [conv(true)], convId: 'c1', messages: HISTORY, historyLoading: false, loaded: true })
    const { container, unmount } = render(<MessageList onRefresh={async () => undefined} />)
    const loader = container.querySelector('.turn-item.live > .live-loader')!
    expect(loader.classList.contains('compacting')).toBe(false)
    expect(loader.querySelectorAll('.cl-orbit > span')).toHaveLength(3)
    unmount()
    const both = { ...conv(true), stalledSince: Date.now() - 65_000, compactingSince: Date.now() - 1_000 } as ConvSummary
    client.store.set({ conversations: [both], convId: 'c1' })
    const again = render(<MessageList onRefresh={async () => undefined} />).container
    expect(again.querySelector('.turn-item.live.stalled')).toBeTruthy()
    expect(again.querySelector('.turn-item.live.compacting')).toBeNull()
  })

  const mount = (c: ConvSummary, messages: ChatMsg[] = HISTORY): HTMLElement => {
    client.store.set({ conversations: [c], convId: 'c1', messages, historyLoading: false, loaded: true })
    return render(<MessageList onRefresh={async () => undefined} />).container
  }

  it('último sinal: "há X s" discreto ao lado do texto; após 20 s sem sinal fica em alerta (quiet); sem lastSignalAt não aparece', () => {
    const fresh = mount({ ...conv(true), lastSignalAt: Date.now() - 5_000 } as ConvSummary)
    const signal = fresh.querySelector('.live-row .live-signal')!
    expect(signal.textContent).toBe('último sinal há 5 s')
    expect(signal.classList.contains('quiet')).toBe(false)
    expect(fresh.querySelector('.live-row .shimmer')?.textContent).toBe('Trabalhando…')
    expect(fresh.querySelector('.live-t')).toBeTruthy()
    cleanup()
    const old = mount({ ...conv(true), lastSignalAt: Date.now() - 65_000 } as ConvSummary)
    expect(old.querySelector('.live-signal')?.textContent).toBe('último sinal há 1:05')
    expect(old.querySelector('.live-signal')?.classList.contains('quiet')).toBe(true)
    expect(old.querySelector('.turn-item.live.quiet')).toBeTruthy()
    cleanup()
    expect(mount(conv(true)).querySelector('.live-signal')).toBeNull()
  })

  it('ferramenta rodando: o "há M:SS" dela ao lado do texto; o sinal some', () => {
    const c = mount({ ...conv(true), lastSignalAt: Date.now() - 30_000 } as ConvSummary, [...HISTORY, grep('g2', false, Date.now() - 65_000)])
    expect(c.querySelector('.live-row .shimmer')?.textContent).toMatch(/^Procurando/)
    expect(c.querySelector('.live-tool')?.textContent).toBe('há 1:05')
    expect(c.querySelector('.live-signal')).toBeNull()
    expect(c.querySelector('.turn-item.live.quiet')).toBeNull()
  })

  it('raciocínio aberto (heartbeat.thinkingSince): "Pensando…" com o tempo dele, sem o sinal; a ferramenta vence', () => {
    const c = mount({ ...conv(true), lastSignalAt: Date.now() - 200_000, thinkingSince: Date.now() - 30_000 } as ConvSummary)
    expect(c.querySelector('.live-row .shimmer')?.textContent).toBe('Pensando…')
    expect(c.querySelector('.live-tool')?.textContent).toBe('há 0:30')
    expect(c.querySelector('.live-signal')).toBeNull()
    expect(c.querySelector('.turn-item.live.quiet')).toBeNull()
    cleanup()
    const both = mount({ ...conv(true), thinkingSince: Date.now() - 30_000 } as ConvSummary, [...HISTORY, grep('g2', false, Date.now() - 10_000)])
    expect(both.querySelector('.live-row .shimmer')?.textContent).toMatch(/^Procurando/)
    expect(both.querySelector('.live-tool')?.textContent).toBe('há 0:10')
  })

  it('detalhe: com o genérico, a última linha do pensamento que chega (cortada em ~90)', () => {
    const long = 'x'.repeat(120)
    const c = mount({ ...conv(true), lastSignalAt: Date.now() - 1_000 } as ConvSummary, [...HISTORY, think('th', `Primeira linha\n\n${long}\n  `, false)])
    const detail = c.querySelector('.live-row .live-detail')!
    expect(detail.textContent).toHaveLength(90)
    expect(detail.textContent?.endsWith('…')).toBe(true)
    expect(c.querySelector('.live-signal')?.textContent).toBe('último sinal há 1 s')
    cleanup()
    // Com o "agora" de uma ferramenta não há detalhe.
    const busyTool = mount(conv(true), [...HISTORY, think('th', 'Vou olhar', false), grep('g2', false)])
    expect(busyTool.querySelector('.live-detail')).toBeNull()
  })

  it('esperando por você: "Aguardando sua permissão…"/"sua resposta…" sem brilho nem sinal; o tempo do turno continua', () => {
    const perm = { id: 'p1', toolName: 'Bash', input: {} }
    const c = mount({ ...conv(true), lastSignalAt: Date.now() - 65_000, permission: perm } as ConvSummary)
    expect(c.querySelector('.turn-item.live.waiting .live-waiting')?.textContent).toBe('Aguardando sua permissão…')
    expect(c.querySelector('.shimmer')).toBeNull()
    expect(c.querySelector('.live-signal')).toBeNull()
    expect(c.querySelector('.turn-item.live.quiet')).toBeNull()
    expect(c.querySelector('.live-t')).toBeTruthy()
    expect(c.querySelector('.live-stop')).toBeTruthy()
    cleanup()
    const ask = { ...perm, toolName: 'AskUserQuestion', questions: [{ header: 'Cor', question: 'Qual?', multiSelect: false, options: [] }] }
    const q = mount({ ...conv(true), permission: ask } as ConvSummary)
    expect(q.querySelector('.live-waiting')?.textContent).toBe('Aguardando sua resposta…')
    cleanup()
    // "Sem resposta" continua vencendo.
    const stalled = mount({ ...conv(true), permission: perm, stalledSince: Date.now() - 65_000 } as ConvSummary)
    expect(stalled.querySelector('.live-stalled')).toBeTruthy()
    expect(stalled.querySelector('.live-waiting')).toBeNull()
  })

  it('card do pensamento ainda chegando: "Pensando…" com o fim do texto ao lado; pronto, só o cabeçalho', () => {
    const noop = (): void => undefined
    const long = 'palavra '.repeat(40).trim() + ' fim do raciocínio'
    const { container, rerender } = render(<MessageItem m={think('th', long, false)} flash={false} voiceReady={false} speakingId={null} onSpeak={noop} />)
    expect(container.querySelector('.msg.thinking.streaming')).toBeTruthy()
    const preview = container.querySelector('.thinking-preview')!
    expect(preview.textContent?.startsWith('…')).toBe(true)
    expect(preview.textContent?.endsWith('fim do raciocínio')).toBe(true)
    expect(preview.textContent!.length).toBeLessThanOrEqual(141)
    rerender(<MessageItem m={think('th', long, true)} flash={false} voiceReady={false} speakingId={null} onSpeak={noop} />)
    expect(container.querySelector('.thinking-preview')).toBeNull()
    expect(container.querySelector('.msg.thinking.streaming')).toBeNull()
    expect(thinkingPreview('curto')).toBe('curto')
    expect(thinkingPreview('a\n\nb   c')).toBe('a b c')
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

  it('com a conversa ocupada os seletores ficam livres: a troca sai e o toast diz que entra na próxima rodada', () => {
    const setModel = vi.spyOn(client, 'setModel').mockResolvedValue(undefined)
    client.store.set({
      conversations: [{ ...conv(true), effort: 'auto', runningEffort: 'high', models: [{ id: 'opus-5.5', label: 'Opus 5.5' }, { id: 'sonnet-5.5', label: 'Sonnet 5.5' }] }],
      convId: 'c1',
      models: [{ id: 'outro', label: 'Outro' }],
      modelEffort: { 'opus-5.5': ['auto', 'high', 'max'] },
      effortLabels: { auto: 'Automático', high: 'Alto', max: 'Máximo' }
    } as never)
    const { getByLabelText } = render(<ModelBar />)
    const model = getByLabelText('Modelo') as HTMLSelectElement
    const effort = getByLabelText('Esforço') as HTMLSelectElement
    expect(model.disabled).toBe(false)
    expect(effort.disabled).toBe(false)
    // A lista do Agent Manager (conv.models) vale sobre a geral; o "Auto · X" do último turno.
    expect([...model.options].map((o) => o.value)).toEqual(['opus-5.5', 'sonnet-5.5'])
    expect(effort.selectedOptions[0].textContent).toBe('Automático · Alto')
    fireEvent.change(effort, { target: { value: 'max' } })
    expect(setModel).toHaveBeenCalledWith({ effort: 'max' })
    expect(toasts.get().list.some((t) => t.text === 'Esforço trocado — entra na próxima rodada')).toBe(true)
  })
})
