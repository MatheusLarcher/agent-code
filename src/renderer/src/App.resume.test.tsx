/**
 * No App inteiro: a falha que não terminou o turno é retomada "de onde parou"
 * (turnRecovery.ts), o reinício do app no meio do turno também retoma
 * (turnInFlight.ts), e a fila só anda com a tarefa terminada de fato — turno
 * principal ocioso E sem subagentes em segundo plano (backgroundHold.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BackgroundTask, ChatEvent, TurnEndWait } from '@shared/ipc'
import { App } from './App'
import { UiProvider } from './ui/UiProvider'
import { cbs, conv, emit, installApi, KEY, sentTexts, seedStorage, stored, toC1, typeInConversation, type FakeApi } from './central/centralAppKit'

configure({ asyncUtilTimeout: 10_000 })
window.HTMLElement.prototype.scrollIntoView = vi.fn()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.mock('./central/CentralPanel', async () => ({ CentralPanel: (await import('./central/centralAppKit')).MockCentralPanel }))

let api: FakeApi
beforeEach(() => {
  seedStorage()
  api = installApi(toC1)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const flush = () =>
  act(async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve()
  })
const sleep = (ms: number) => act(async () => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const agent: BackgroundTask = { id: 'sub-1', type: 'local_agent', description: 'revisor' }
const shell: BackgroundTask = { id: 'dev', type: 'local_bash', description: 'npm run dev' }
const background = (tasks: BackgroundTask[]): ChatEvent => ({ kind: 'background-tasks', tasks })
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: 'ok', durationMs: 1 }
const partial: ChatEvent = { kind: 'assistant-text', id: 'a1', text: 'metade da resposta', final: false }
const recoveryCard = (): Element | null => document.querySelector('.recovery-card')
const storedC1 = () => stored().find((c) => c.id === 'c1') as { turnInFlight?: Record<string, unknown>; messages: Array<{ id: string; error?: string }> } | undefined
const queued = (): string[] => Array.from(document.querySelectorAll('.queue-text')).map((e) => e.textContent ?? '')
const mount = () => render(<UiProvider><App /></UiProvider>)

/** `waitTurnEnd` controlado: cada chamada fica pendente até o teste soltar. */
function controlledTurnEnd(): { calls: ReturnType<typeof vi.fn>; release: () => Promise<void> } {
  const ends: Array<(v: TurnEndWait) => void> = []
  const calls = vi.fn(() => new Promise<TurnEndWait>((resolve) => ends.push(resolve)))
  Object.assign(window.api as object, { waitTurnEnd: calls })
  return {
    calls,
    release: async () => {
      await waitFor(() => expect(ends.length).toBeGreaterThan(0))
      await act(async () => ends.shift()?.({ settled: true, reason: 'idle' }))
      await flush()
    }
  }
}

describe('falha que não terminou o turno (`incomplete`)', () => {
  it('mensagem do usuário: mesmo com texto recebido vira retomada agendada, e a fila não anda', async () => {
    mount()
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await emit(partial)
    await typeInConversation('segunda')
    await emit({ kind: 'error', id: 'e1', text: 'O turno parou no meio.', incomplete: true })
    await flush()
    await waitFor(() => expect(recoveryCard()).not.toBeNull())
    expect(screen.getByText(/Nova tentativa em/)).toBeTruthy()
    expect(sentTexts(api)).toEqual(['primeira'])
    expect(queued()).toEqual(['segunda'])
    await waitFor(() => expect(storedC1()?.messages.find((m) => m.error)?.error).toBe('O turno parou no meio.'))
  })

  it('tarefa MCP: regra 2 — sem retomada e sem reenvio', async () => {
    mount()
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await emit(result)
    await act(async () => cbs.mcp?.({ taskId: 't1', convId: 'c1', text: 'tarefa 1' }))
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1']))
    await emit(partial)
    await emit({ kind: 'error', id: 'e1', text: 'O turno parou no meio.', incomplete: true })
    await waitFor(() => expect(screen.getAllByText(/Tarefa do Forgia terminou em erro/).length).toBeGreaterThan(0))
    await sleep(300)
    expect(recoveryCard()).toBeNull()
    expect(sentTexts(api)).toEqual(['primeira', 'tarefa 1'])
    expect(api.sendMessage.mock.calls.some((c: unknown[]) => c[6] === 'recovery')).toBe(false)
  })
})

describe('subagentes em segundo plano seguram a fila', () => {
  it('o result não despacha, o que chega entra na fila, e o fim deles solta a cabeça — uma vez, depois do fim real do turno', async () => {
    const turnEnd = controlledTurnEnd()
    mount()
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await emit(background([agent]))
    await typeInConversation('segunda')
    await emit(result)
    await flush()
    // Turno principal acabou, a tarefa não: nada sai, nem a espera do main começa.
    expect(sentTexts(api)).toEqual(['primeira'])
    expect(turnEnd.calls).not.toHaveBeenCalled()
    // Conversa ociosa, mas com subagente: mensagem nova e tarefa MCP entram na fila.
    await typeInConversation('terceira')
    await act(async () => cbs.mcp?.({ taskId: 't1', convId: 'c1', text: 'tarefa 1' }))
    await flush()
    expect(sentTexts(api)).toEqual(['primeira'])
    expect(queued()).toEqual(['segunda', 'terceira', 'tarefa 1'])
    // O subagente acaba (fica só o servidor, que não segura): intervalo, fim real, conferência.
    await emit(background([shell]))
    await waitFor(() => expect(turnEnd.calls).toHaveBeenCalledWith('c1'))
    expect(sentTexts(api)).toEqual(['primeira'])
    await turnEnd.release()
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda']))
    // Snapshot repetido sem subagente: nada sai de novo.
    await emit(background([]))
    await sleep(2_000)
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
    // Daí em diante, o fluxo normal da fila.
    await emit(result)
    await turnEnd.release()
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda', 'terceira']))
  })

  it('shell/servidor em segundo plano não segura a fila', async () => {
    mount()
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await emit(background([shell]))
    await typeInConversation('segunda')
    await emit(result)
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda']))
  })

  it('o fim do turno principal chegando DEPOIS dos subagentes segue o fluxo normal', async () => {
    mount()
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await emit(background([agent]))
    await typeInConversation('segunda')
    await emit(background([]))
    await emit(result)
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda']))
    await sleep(2_000)
    expect(sentTexts(api)).toEqual(['primeira', 'segunda'])
  })

  it('"agora" com a conversa ociosa e subagente rodando: sai já', async () => {
    mount()
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await emit(background([agent]))
    await typeInConversation('segunda')
    await emit(result)
    await flush()
    expect(sentTexts(api)).toEqual(['primeira'])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'agora' }))
    })
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda']))
  })

  it('troca de modelo com a conversa ociosa e subagente: não derruba a sessão; entra quando ele acaba', async () => {
    mount()
    const select = (): HTMLSelectElement => document.querySelector('select.model-select') as HTMLSelectElement
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await emit(background([agent]))
    await emit(result)
    await flush()
    fireEvent.change(select(), { target: { value: 'claude-sonnet-5-5' } })
    await flush()
    expect(api.disposeAgent).not.toHaveBeenCalled()
    expect(screen.getAllByText(/entra quando os subagentes em segundo plano terminarem/).length).toBeGreaterThan(0)
    await typeInConversation('segunda')
    await flush()
    expect(api.disposeAgent).not.toHaveBeenCalled()
    expect(sentTexts(api)).toEqual(['primeira'])
    await emit(background([]))
    await waitFor(() => expect(api.disposeAgent).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda']))
    expect(api.startAgent).toHaveBeenCalledTimes(2)
    expect((api.startAgent.mock.calls[1][0] as { model: string }).model).toBe('claude-sonnet-5-5')
  })
})

describe('reinício do app no meio do turno', () => {
  const seedTurn = (turnInFlight: Record<string, unknown>, extra: Record<string, unknown> = {}): void => {
    const c1 = conv('c1', 'Conversa', '/proj', {
      sdkSessionId: 'sess-1',
      messages: [{ kind: 'user', id: 'u1', text: 'faça X' }],
      turnInFlight,
      ...extra
    })
    localStorage.setItem(KEY, JSON.stringify([c1]))
  }

  it('a marca é gravada ao enviar e limpa no terminal', async () => {
    mount()
    await typeInConversation('primeira')
    await waitFor(() => expect(storedC1()?.turnInFlight).toMatchObject({ sent: true, device: 'pc-teste' }))
    await emit(result)
    await waitFor(() => expect(storedC1()?.turnInFlight).toBeUndefined())
  })

  it('turno enviado: a conversa retoma "de onde parou" com o resume da sessão', async () => {
    seedTurn({ msgId: 'u1', at: 1, sent: true, device: 'pc-teste' })
    mount()
    await waitFor(() => expect(recoveryCard()).not.toBeNull())
    expect(screen.getAllByText(/continua de onde parou/).length).toBeGreaterThan(0)
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    const [convId, text, , , , , origin] = api.sendMessage.mock.calls[0] as unknown[]
    expect(convId).toBe('c1')
    expect(String(text)).toMatch(/^Continue exatamente de onde parou/)
    expect(origin).toBe('recovery')
    expect((api.startAgent.mock.calls[0][0] as { resume?: string }).resume).toBe('sess-1')
  })

  it('tarefa MCP: não reenvia — só limpa a marca e avisa', async () => {
    seedTurn({ msgId: 'u1', at: 1, sent: true, mcpTaskId: 't1', device: 'pc-teste' })
    mount()
    await waitFor(() => expect(screen.getAllByText(/tarefa do Forgia estava em andamento/).length).toBeGreaterThan(0))
    await waitFor(() => expect(storedC1()?.turnInFlight).toBeUndefined())
    await sleep(2_500)
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(recoveryCard()).toBeNull()
  })

  it('marca de outro PC: este não retoma', async () => {
    seedTurn({ msgId: 'u1', at: 1, sent: true, device: 'outro-pc' })
    mount()
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    await sleep(2_500)
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(recoveryCard()).toBeNull()
  })
})

describe('fila restaurada do banco no boot', () => {
  it('conversa livre manda a cabeça sozinha; com recuperação pendente, espera a recuperação', async () => {
    const restored = (text: string) => ({ full: text, text, images: [], thumbs: [], files: [], fileRefs: [] })
    const recovery = { id: 'r', reason: 'limit', scheduledAt: Date.now() + 600_000, attempt: 0, maxAttempts: 5, errorText: 'session limit', messageId: null }
    localStorage.setItem(KEY, JSON.stringify([conv('c1', 'Conversa', '/proj'), conv('c2', 'Outra', '/proj', { recovery })]))
    Object.assign(window.api as object, {
      outboxList: vi.fn(async () => [
        { conversationId: 'c1', id: 'q1', payload: restored('livre 1') },
        { conversationId: 'c1', id: 'q2', payload: restored('livre 2') },
        { conversationId: 'c2', id: 'q3', payload: restored('presa') }
      ]),
      outboxReplace: vi.fn(async () => ({ ok: true }))
    })
    mount()
    expect((await screen.findAllByText(/saem sozinhas/)).length).toBeGreaterThan(0)
    await waitFor(() => expect(sentTexts(api)).toEqual(['livre 1']))
    await sleep(2_000)
    // Uma por vez: a segunda sai no fim do turno da primeira; a da c2 espera a recuperação.
    expect(sentTexts(api)).toEqual(['livre 1'])
    await emit(result)
    await waitFor(() => expect(sentTexts(api)).toEqual(['livre 1', 'livre 2']))
    expect(sentTexts(api)).not.toContain('presa')
  })
})
