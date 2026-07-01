import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { UiProvider } from './ui/UiProvider'
import { App } from './App'
import type { AgentEventMsg, ChatEvent } from '@shared/ipc'

// jsdom has no layout engine — stub the DOM APIs the panels rely on.
window.HTMLElement.prototype.scrollIntoView = vi.fn()
class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO

// Captured from the mock so tests can drive the agent event stream and control
// when `startAgent` (the connect IPC) resolves.
let agentEventCb: ((m: AgentEventMsg) => void) | null = null
let resolveStart: Array<(v: { ok: boolean }) => void> = []

function installApi(): Record<string, ReturnType<typeof vi.fn>> {
  agentEventCb = null
  resolveStart = []
  const api = {
    getConfig: vi.fn(async () => ({ stitch: { enabled: false, apiKey: '' }, skipPermissions: false })),
    setConfig: vi.fn(async () => {}),
    authStatus: vi.fn(async () => ({ authenticated: true })),
    authLogin: vi.fn(async () => ({ ok: true })),
    pathExists: vi.fn(async () => true),
    pickDirectory: vi.fn(async () => null),
    pickFile: vi.fn(async () => null),
    // Cache-folder store: back kv on localStorage so the seeded data loads.
    kvGet: vi.fn(async (key: string) => localStorage.getItem(key)),
    kvSet: vi.fn(async (key: string, value: string) => {
      localStorage.setItem(key, value)
    }),
    getCacheInfo: vi.fn(async () => ({ dir: '', dbPath: '', memoriesDir: '' })),
    chooseCacheDir: vi.fn(async () => null),
    downloadFile: vi.fn(async () => ({ ok: true, message: '' })),
    startAgent: vi.fn(() => new Promise<{ ok: boolean }>((res) => resolveStart.push(res))),
    sendMessage: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    setBypass: vi.fn(async () => {}),
    respondPermission: vi.fn(async () => {}),
    disposeAgent: vi.fn(async () => {}),
    refreshUsage: vi.fn(async () => {}),
    onAgentEvent: vi.fn((cb: (m: AgentEventMsg) => void) => {
      agentEventCb = cb
      return () => {}
    }),
    onPermissionRequest: vi.fn(() => () => {}),
    onPermissionExpired: vi.fn(() => () => {}),
    launchBrowser: vi.fn(async () => {}),
    navigate: vi.fn(async () => ''),
    browserBack: vi.fn(async () => {}),
    browserForward: vi.fn(async () => {}),
    browserReload: vi.fn(async () => {}),
    setSelectMode: vi.fn(async () => {}),
    sendBrowserInput: vi.fn(async () => {}),
    closeBrowser: vi.fn(async () => {}),
    setBrowserViewport: vi.fn(async () => {}),
    setActiveBrowser: vi.fn(async () => {}),
    disposeBrowser: vi.fn(async () => {}),
    newTab: vi.fn(async () => {}),
    selectTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    onBrowserFrame: vi.fn(() => () => {}),
    onBrowserState: vi.fn(() => () => {}),
    onBrowserPicked: vi.fn(() => () => {}),
    onAndroidProgress: vi.fn(() => () => {}),
    remoteStart: vi.fn(async () => ({ running: true, url: '', ip: '', port: 0, token: '', clients: 0, relayConnected: false })),
    remoteStop: vi.fn(async () => ({ running: false, url: '', ip: '', port: 0, token: '', clients: 0, relayConnected: false })),
    remoteStatus: vi.fn(async () => ({ running: false, url: '', ip: '', port: 0, token: '', clients: 0, relayConnected: false })),
    publishRemoteState: vi.fn(async () => {}),
    buildRemoteApk: vi.fn(async () => ({ ok: true, message: '' })),
    onRemoteInbound: vi.fn(() => () => {}),
    onRemoteSetSkipPerms: vi.fn(() => () => {}),
    onRemoteSetModel: vi.fn(() => () => {}),
    onRemoteBuildProgress: vi.fn(() => () => {}),
    onRemoteClients: vi.fn(() => () => {})
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  localStorage.clear()
  const conv = {
    id: 'c1',
    title: 'Conversa',
    cwd: '/proj',
    model: 'claude-opus-4-8',
    sdkSessionId: null,
    messages: [],
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 2
  }
  localStorage.setItem('agentcode.conversations.v1', JSON.stringify([conv]))
  localStorage.setItem('agentcode.ui.v1', JSON.stringify({ collapsed: false, activeId: 'c1', browserMinimized: false }))
  api = installApi()
})
afterEach(cleanup)

const result: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: 'done', durationMs: 1 }
const partial: ChatEvent = { kind: 'assistant-text', id: 'a1', text: 'trabalhando', final: false }

async function emit(event: ChatEvent): Promise<void> {
  await act(async () => {
    agentEventCb?.({ convId: 'c1', event })
  })
}
async function flushConnect(): Promise<void> {
  await act(async () => {
    resolveStart.forEach((r) => r({ ok: true }))
    resolveStart = []
  })
}
async function send(text: string): Promise<HTMLElement> {
  const ta = await screen.findByPlaceholderText(/Mensagem para o Claude/i)
  fireEvent.change(ta, { target: { value: text } })
  fireEvent.keyDown(ta, { key: 'Enter' })
  return ta
}

describe('App — fila de mensagens (multi-sessão)', () => {
  it('enviar com a tarefa rodando ENFILEIRA (não cancela) e despacha no fim do turno', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('msg1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    // O cronômetro da tarefa em execução aparece no topo do chat.
    expect(screen.getByText(/⏱/)).toBeTruthy()

    await emit(partial) // ainda ocupado
    await send('msg2') // deve ir para a fila, não enviar
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Na fila/)).toBeTruthy()

    await emit(result) // turno terminou → despacha a fila
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2))
    expect(String(api.sendMessage.mock.calls[1][1])).toContain('msg2')
    expect(screen.queryByText(/Na fila/)).toBeNull()
  })

  it('dois envios durante a conexão: UMA sessão (startAgent 1x) e o segundo vai pra fila', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('m1') // connect fica pendente (não resolvido)
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))

    await send('m2') // durante a janela do connect → deve enfileirar, não reconectar
    expect(api.startAgent).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Na fila/)).toBeTruthy()

    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
  })

  it('parar (■) com fila NÃO despacha a próxima — vai para ociosa', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('msg1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    await emit(partial)
    await send('msg2')
    expect(screen.getByText(/Na fila/)).toBeTruthy()

    fireEvent.click(screen.getByTitle('Parar tarefa atual'))
    expect(api.interrupt).toHaveBeenCalledWith('c1')

    await emit(result) // o 'result' vindo da interrupção não pode despachar a fila
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/Na fila/)).toBeNull()
  })
})

describe('App — barra de limite de contexto', () => {
  it('mostra o uso da janela de entrada sobre o limite do modelo (Opus = 1M) e atualiza no fim do turno', async () => {
    const { container } = render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    // O valor "X / Y" é renderizado em nós de texto separados; lê o textContent.
    const ctxVal = (): string => container.querySelector('.ctx-bar-val')?.textContent ?? ''

    // Abre a conversa (Opus, limite 1M) — antes de qualquer turno, a janela está em 0.
    await send('oi')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    expect(screen.getByText('entrada')).toBeTruthy()
    expect(ctxVal()).toBe('0 / 1M')

    // Um turno termina informando o tamanho real da janela enviada ao modelo
    // (result sempre traz `usage`; `contextTokens` é a janela de entrada real).
    await emit({
      kind: 'result',
      id: 'rctx',
      isError: false,
      text: 'done',
      durationMs: 1,
      contextTokens: 120000,
      usage: { input: 120000, output: 50, cacheRead: 0, cacheWrite: 0 }
    })
    await waitFor(() => expect(ctxVal()).toBe('120.0k / 1M'))

    // O contexto de saída é separado (acumulado), não se mistura com a janela de entrada.
    expect(screen.getByText(/↑ .* saída/)).toBeTruthy()
  })
})

describe('App — trocar de modelo sem precisar parar a sessão manualmente', () => {
  it('travado enquanto o agente está OCUPADO; destrava quando termina o turno', async () => {
    const { container } = render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    const select = (): HTMLSelectElement => container.querySelector('select.model-select') as HTMLSelectElement

    await send('msg1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    // Logo após enviar, o turno está em andamento — o seletor deve estar travado.
    expect(select().getAttribute('aria-disabled')).toBe('true')

    await emit(result) // turno termina — sessão continua conectada, mas ociosa
    await waitFor(() => expect(select().getAttribute('aria-disabled')).toBe('false'))
  })

  it('trocar o modelo com a sessão ociosa reinicia a sessão em silêncio (sem clicar em "Parar")', async () => {
    const { container } = render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    const select = (): HTMLSelectElement => container.querySelector('select.model-select') as HTMLSelectElement

    await send('msg1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    await emit(result) // fim do turno → ocioso, mas ainda conectado
    await waitFor(() => expect(select().getAttribute('aria-disabled')).toBe('false'))

    // Troca o modelo sem clicar em "Parar sessão".
    fireEvent.change(select(), { target: { value: 'claude-sonnet-5' } })

    // A sessão antiga é encerrada em silêncio (sem exigir o botão "Parar").
    await waitFor(() => expect(api.disposeAgent).toHaveBeenCalledWith('c1'))
    expect(select().value).toBe('claude-sonnet-5')
    expect(screen.getByText(/Modelo trocado/)).toBeTruthy()

    // A próxima mensagem reconecta — já com o modelo novo.
    await send('msg2')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(2))
    const lastCall = api.startAgent.mock.calls[1][0] as { model: string }
    expect(lastCall.model).toBe('claude-sonnet-5')
  })

  it('trocar o modelo com a sessão DESCONECTADA não chama disposeAgent (nada pra encerrar)', async () => {
    const { container } = render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    const select = (): HTMLSelectElement => container.querySelector('select.model-select') as HTMLSelectElement
    await waitFor(() => expect(select()).toBeTruthy())
    expect(select().getAttribute('aria-disabled')).toBe('false')

    fireEvent.change(select(), { target: { value: 'claude-haiku-4-5' } })
    expect(select().value).toBe('claude-haiku-4-5')
    expect(api.disposeAgent).not.toHaveBeenCalled()
  })
})

describe('App — uso da conta (5h/semana) na topbar, global (não é por conversa)', () => {
  it('evento rate-limit atualiza a topbar mesmo sem nenhuma conversa conectada', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    // Nenhum "Ligar"/conectar aconteceu — o badge não depende de sessão ativa.
    await emit({
      kind: 'rate-limit',
      limits: { rateLimitType: 'five_hour', status: 'allowed_warning', utilization: 0.81 }
    })
    await waitFor(() => expect(screen.getByText('Sessão 5h')).toBeTruthy())
    expect(screen.getByText('81%')).toBeTruthy()
  })

  it('sobrevive à troca de conversa (é da conta, não da conversa aberta)', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await emit({
      kind: 'rate-limit',
      limits: { rateLimitType: 'seven_day', status: 'allowed', utilization: 0.3 }
    })
    await waitFor(() => expect(screen.getByText('Semana')).toBeTruthy())

    // Enviar uma mensagem (conecta/troca estado da conversa) não deve mexer no badge.
    await send('oi')
    expect(screen.getByText('Semana')).toBeTruthy()
    expect(screen.getByText('30%')).toBeTruthy()
  })

  it('carrega o último snapshot salvo ao abrir o app', async () => {
    localStorage.setItem(
      'agentcode.usage-limits.v1',
      JSON.stringify({
        five_hour: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.5, updatedAt: Date.now() }
      })
    )
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await waitFor(() => expect(screen.getByText('Sessão 5h')).toBeTruthy())
    expect(screen.getByText('50%')).toBeTruthy()
  })

})
