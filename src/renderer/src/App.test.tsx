import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, configure } from '@testing-library/react'
import { UiProvider } from './ui/UiProvider'
import { App } from './App'
import type { AgentEventMsg, ChatEvent } from '@shared/ipc'
import type { TodoItem } from './types'

// This file mounts the full app dozens of times. Under the complete parallel
// suite, jsdom can spend over 1s transforming/settling sibling files even though
// the same flow completes in ~250ms in isolation.
configure({ asyncUtilTimeout: 3_000 })

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
    // Conversations: in real code this fans out to one db per project, but the
    // component doesn't care — same localStorage key the tests already seed/assert on.
    loadAllConversations: vi.fn(async () => JSON.parse(localStorage.getItem('agentcode.conversations.v1') || '[]')),
    saveAllConversations: vi.fn(async (list: unknown[]) => {
      localStorage.setItem('agentcode.conversations.v1', JSON.stringify(list))
    }),
    getCacheInfo: vi.fn(async () => ({ dir: '', dbPath: '', memoriesDir: '' })),
    chooseCacheDir: vi.fn(async () => null),
    downloadFile: vi.fn(async () => ({ ok: true, message: '' })),
    resolvePastedPath: vi.fn(async () => ({ ok: false, error: 'not used in these tests' })),
    downloadPastedUrl: vi.fn(async () => ({ ok: false, error: 'not used in these tests' })),
    readFileBytes: vi.fn(async () => ({ ok: false, error: 'not used in these tests' })),
    startAgent: vi.fn(() => new Promise<{ ok: boolean }>((res) => resolveStart.push(res))),
    sendMessage: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ stillQueued: [] })),
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
    onRemoteRecoveryAction: vi.fn(() => () => {}),
    onRemotePermissionResponse: vi.fn(() => () => {}),
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

async function emit(event: ChatEvent, convId = 'c1'): Promise<void> {
  await act(async () => {
    agentEventCb?.({ convId, event })
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

// Paste a line that looks like a local path/URL — mirrors a real OS paste
// (clipboardData with only text/plain, no file), driving the Composer's
// onPaste exactly like Composer.draft.test.tsx-style tests do at this layer.
async function pasteLine(line: string): Promise<void> {
  const ta = await screen.findByPlaceholderText(/Mensagem para o Claude/i)
  const clipboardData = {
    items: [] as { kind: string }[],
    getData: (type: string) => (type === 'text/plain' ? line : '')
  }
  await act(async () => {
    fireEvent.paste(ta, { clipboardData })
  })
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

  it('mantém aviso quando o SDK diz que uma mensagem sobreviveu ao Stop', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('msg que sobrevive')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    const sdkUuid = String(api.sendMessage.mock.calls[0][5])
    api.interrupt.mockResolvedValueOnce({
      stillQueued: [{ messageId: sdkUuid, text: 'msg que sobrevive' }]
    })

    fireEvent.click(screen.getByTitle('Parar tarefa atual'))
    await waitFor(() => expect(screen.getByText('O Stop não cancelou tudo.')).toBeTruthy())
    expect(screen.getAllByText('msg que sobrevive').length).toBeGreaterThan(1)

    await emit(result) // resultado do turno interrompido: o sobrevivente ainda vai rodar
    expect(screen.getByText('O Stop não cancelou tudo.')).toBeTruthy()
    await emit(partial)
    await emit(result) // resultado do sobrevivente: aviso pode sair
    await waitFor(() => expect(screen.queryByText('O Stop não cancelou tudo.')).toBeNull())
  })
})

describe('App — tarefas em segundo plano do SDK', () => {
  it('substitui o painel inteiro a cada background_tasks_changed', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await waitFor(() => expect(agentEventCb).not.toBeNull())
    await emit({
      kind: 'background-tasks',
      tasks: [{ id: 'bg1', type: 'bash', description: 'Servidor local' }]
    })
    expect(screen.getByText('Servidor local')).toBeTruthy()
    await emit({ kind: 'background-tasks', tasks: [] })
    expect(screen.queryByText('Servidor local')).toBeNull()
  })
})

describe('App — anexo por referência (fileRefs: caminho/link colado)', () => {
  it('colar um caminho local vira chip e o envio manda o fileRef pro main (path, sem base64)', async () => {
    api.resolvePastedPath = vi.fn(async () => ({
      ok: true,
      name: 'relatorio.pdf',
      path: 'C:\\pasta\\relatorio.pdf',
      mediaType: 'application/pdf',
      size: 123456,
      isImage: false
    }))
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    await pasteLine('C:\\pasta\\relatorio.pdf')
    await waitFor(() => expect(screen.getByText('relatorio.pdf')).toBeTruthy())

    fireEvent.keyDown(await screen.findByPlaceholderText(/Mensagem para o Claude/i), { key: 'Enter' })
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    const [, , images, files, fileRefs] = api.sendMessage.mock.calls[0]
    expect(images).toEqual([])
    expect(files).toEqual([]) // o caminho local NÃO passa pelo fluxo de FileAttachment (base64)
    expect(fileRefs).toEqual([
      { name: 'relatorio.pdf', path: 'C:\\pasta\\relatorio.pdf', mediaType: 'application/pdf', size: 123456 }
    ])
  })

  it('enviar com fileRef durante turno ocupado ENFILEIRA e despacha com o fileRef preservado', async () => {
    api.resolvePastedPath = vi.fn(async () => ({
      ok: true,
      name: 'notas.txt',
      path: 'C:\\pasta\\notas.txt',
      mediaType: 'text/plain',
      size: 42,
      isImage: false
    }))
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('msg1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    await emit(partial) // turno ainda rodando

    await pasteLine('C:\\pasta\\notas.txt')
    await waitFor(() => expect(screen.getByText('notas.txt')).toBeTruthy())
    fireEvent.keyDown(await screen.findByPlaceholderText(/Mensagem para o Claude/i), { key: 'Enter' })
    expect(screen.getByText(/Na fila/)).toBeTruthy()
    expect(api.sendMessage).toHaveBeenCalledTimes(1) // ainda não despachou

    await emit(result) // turno termina → despacha a fila
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2))
    const [, , , , fileRefs] = api.sendMessage.mock.calls[1]
    expect(fileRefs).toEqual([
      { name: 'notas.txt', path: 'C:\\pasta\\notas.txt', mediaType: 'text/plain', size: 42 }
    ])
    expect(screen.queryByText(/Na fila/)).toBeNull()
  })

  it('"Tentar de novo" numa mensagem com fileRef que falhou reenvia o mesmo fileRef', async () => {
    api.resolvePastedPath = vi.fn(async () => ({
      ok: true,
      name: 'dados.csv',
      path: 'C:\\pasta\\dados.csv',
      mediaType: 'text/csv',
      size: 999,
      isImage: false
    }))
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    await pasteLine('C:\\pasta\\dados.csv')
    await waitFor(() => expect(screen.getByText('dados.csv')).toBeTruthy())
    fireEvent.keyDown(await screen.findByPlaceholderText(/Mensagem para o Claude/i), { key: 'Enter' })
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    // O turno falha com um erro transitório (não é de rate-limit) — o app agenda
    // retries automáticos; o botão manual "Tentar de novo" só habilita quando as
    // tentativas automáticas se esgotam (MAX_GENERIC_RETRIES). Emitir o mesmo
    // erro repetidas vezes evolui `attempt` a cada rodada até esgotar.
    for (let i = 0; i < 6; i++) {
      await emit({ kind: 'error', id: `e${i}`, text: 'sessão caiu' })
    }
    const retryBtn = await screen.findByText(/Tentar de novo/)
    const retryButtonEl = retryBtn.closest('button') as HTMLButtonElement
    expect(retryButtonEl.disabled).toBe(false)
    // A fatal 'error' event disconnects the conversation (setConnected(cid, false)),
    // so retryMessage's `await connect(conv)` re-issues startAgent — flush it too.
    await act(async () => {
      fireEvent.click(retryButtonEl)
    })
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2))

    const [, , , , fileRefsOnRetry] = api.sendMessage.mock.calls[1]
    expect(fileRefsOnRetry).toEqual([
      { name: 'dados.csv', path: 'C:\\pasta\\dados.csv', mediaType: 'text/csv', size: 999 }
    ])
  })
})

describe('App — recuperação persistida', () => {
  it('restaura o cartão e não envia antes do horário agendado', async () => {
    const conv = JSON.parse(localStorage.getItem('agentcode.conversations.v1') || '[]')[0]
    conv.recovery = {
      id: 'rec1', reason: 'limit', scheduledAt: Date.now() + 60_000,
      attempt: 0, maxAttempts: 5, errorText: 'session limit', messageId: null
    }
    localStorage.setItem('agentcode.conversations.v1', JSON.stringify([conv]))
    render(<UiProvider><App /></UiProvider>)
    expect(await screen.findByText('Limite do Claude atingido')).toBeTruthy()
    expect(screen.getByText(/Nova tentativa em/)).toBeTruthy()
    expect(api.sendMessage).not.toHaveBeenCalled()
  })
})

describe('App — indicador "trabalhando" se autocorrige após um result prematuro', () => {
  // Consulta pelo elemento real da faixa (não por texto — a bolha da mensagem
  // usada como fixture de "atividade" também contém a palavra "trabalhando").
  const workingBanner = (): Element | null => document.querySelector('.working-banner')

  it('atividade chegando pra uma conversa já "ociosa" liga o indicador de novo (sem re-despachar a fila)', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('msg1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    expect(workingBanner()).toBeTruthy() // faixa "Claude está trabalhando"

    // result PREMATURO (ex.: de um subagente que escapou do filtro do main) —
    // desliga o indicador como se o turno tivesse acabado de verdade.
    await emit(result)
    expect(workingBanner()).toBeNull()

    // mas o turno de verdade CONTINUA gerando atividade depois disso —
    // o indicador tem que voltar sozinho, sem o usuário reenviar nada.
    await emit(partial)
    expect(workingBanner()).toBeTruthy()
    // não é um novo turno — não deve ter despachado nada extra.
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('atividade chegando pra uma conversa JÁ ocupada não reinicia nada (idempotente)', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('msg1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(partial) // já estava ocupado — só mais uma atividade normal
    expect(workingBanner()).toBeTruthy()
    expect(api.sendMessage).toHaveBeenCalledTimes(1)
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

  it('ignora um 0% espúrio quando o snapshot atual ainda não resetou', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await emit({
      kind: 'rate-limit',
      limits: {
        rateLimitType: 'five_hour',
        status: 'allowed',
        utilization: 0.62,
        resetsAt: Date.now() + 60 * 60 * 1000 // ainda falta 1h para o reset real
      }
    })
    await waitFor(() => expect(screen.getByText('62%')).toBeTruthy())
    // Sessão nova reporta 0% / "já resetou" sem dado real — deve ser descartado.
    await emit({
      kind: 'rate-limit',
      limits: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0 }
    })
    expect(screen.getByText('62%')).toBeTruthy()
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('aceita o 0% quando o horário de reset já passou (reset de verdade)', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await emit({
      kind: 'rate-limit',
      limits: {
        rateLimitType: 'five_hour',
        status: 'allowed',
        utilization: 0.62,
        resetsAt: Date.now() - 1000 // reset já aconteceu
      }
    })
    await waitFor(() => expect(screen.getByText('62%')).toBeTruthy())
    await emit({
      kind: 'rate-limit',
      limits: { rateLimitType: 'five_hour', status: 'allowed', utilization: 0 }
    })
    await waitFor(() => expect(screen.getByText('0%')).toBeTruthy())
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

// Reads what the app persisted for the seeded conversation ('c1') — the same
// mechanism App.tsx itself uses (saveConversations -> window.api.saveAllConversations),
// so these assert on real persisted state, not an internal implementation detail.
function savedConv(): { todoPlan?: { items: TodoItem[]; active: boolean } } | undefined {
  const list = JSON.parse(localStorage.getItem('agentcode.conversations.v1') || '[]')
  return list.find((c: { id: string }) => c.id === 'c1')
}

const todoWriteEvent = (todos: TodoItem[]): ChatEvent => ({
  kind: 'tool-use',
  id: 'tw1',
  name: 'TodoWrite',
  input: { todos },
  parentToolUseId: null
})

describe('App — TodoWrite vira um plano fixo, não um card no feed de mensagens', () => {
  it('TodoWrite não aparece na lista de mensagens e atualiza o todoPlan persistido', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(
      todoWriteEvent([
        { content: 'Passo 1', status: 'in_progress', activeForm: 'Fazendo o passo 1' },
        { content: 'Passo 2', status: 'pending', activeForm: 'Fazendo o passo 2' }
      ])
    )

    // Nenhum card de ferramenta "TodoWrite" no feed — nem o nome da tool nem o
    // conteúdo cru do input aparecem como mensagem.
    expect(screen.queryByText('TodoWrite')).toBeNull()
    expect(screen.queryByText(/Passo 1/)).toBeNull()

    await waitFor(() => {
      const plan = savedConv()?.todoPlan
      expect(plan?.active).toBe(true)
      expect(plan?.items).toEqual([
        { content: 'Passo 1', status: 'in_progress', activeForm: 'Fazendo o passo 1' },
        { content: 'Passo 2', status: 'pending', activeForm: 'Fazendo o passo 2' }
      ])
    })
  })

  it('uma segunda chamada de TodoWrite SUBSTITUI o plano (não acumula itens)', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(
      todoWriteEvent([
        { content: 'Passo 1', status: 'in_progress', activeForm: 'Fazendo o passo 1' },
        { content: 'Passo 2', status: 'pending', activeForm: 'Fazendo o passo 2' }
      ])
    )
    await waitFor(() => expect(savedConv()?.todoPlan?.items).toHaveLength(2))

    await emit(
      todoWriteEvent([
        { content: 'Passo 1', status: 'completed', activeForm: 'Fazendo o passo 1' },
        { content: 'Passo 2', status: 'in_progress', activeForm: 'Fazendo o passo 2' }
      ])
    )

    await waitFor(() => {
      const plan = savedConv()?.todoPlan
      expect(plan?.items).toHaveLength(2) // não virou 4
      expect(plan?.items[0].status).toBe('completed')
      expect(plan?.items[1].status).toBe('in_progress')
    })
  })

  it('o turno terminar (result) marca active:false mesmo com itens ainda pendentes', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(
      todoWriteEvent([
        { content: 'Passo 1', status: 'completed', activeForm: 'Fazendo o passo 1' },
        { content: 'Passo 2', status: 'pending', activeForm: 'Fazendo o passo 2' }
      ])
    )
    await waitFor(() => expect(savedConv()?.todoPlan?.active).toBe(true))

    await emit(result) // turno termina — interrompido/concluído, itens continuam como estavam

    await waitFor(() => {
      const plan = savedConv()?.todoPlan
      expect(plan?.active).toBe(false)
      expect(plan?.items).toHaveLength(2) // itens preservados, só o spinner para
    })
  })

  it('input malformado de TodoWrite não derruba o app nem sobrescreve um plano válido anterior', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(todoWriteEvent([{ content: 'Passo 1', status: 'in_progress', activeForm: 'Fazendo o passo 1' }]))
    await waitFor(() => expect(savedConv()?.todoPlan?.items).toHaveLength(1))

    // input malformado (sem 'todos', ou com status inválido) — extractTodoPlan
    // deve devolver null e o plano anterior permanece intacto.
    await emit({ kind: 'tool-use', id: 'tw2', name: 'TodoWrite', input: { oops: true }, parentToolUseId: null })
    await emit({
      kind: 'tool-use',
      id: 'tw3',
      name: 'TodoWrite',
      input: { todos: [{ content: 'x', status: 'nope', activeForm: 'y' }] },
      parentToolUseId: null
    })

    expect(savedConv()?.todoPlan?.items).toHaveLength(1)
    expect(savedConv()?.todoPlan?.items[0].content).toBe('Passo 1')
  })
})

describe('App — TodoPlanCard renderizado de verdade (end-to-end)', () => {
  it('card aparece fixo acima da composer, atualiza ao vivo, e recolhe quando o turno termina', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('corrige X e Y, com testes')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    // Sem TodoWrite ainda — nenhum card no DOM.
    expect(document.querySelector('.todo-plan-card')).toBeNull()

    await emit(
      todoWriteEvent([
        { content: 'Corrigir X', status: 'in_progress', activeForm: 'Corrigindo X' },
        { content: 'Corrigir Y', status: 'pending', activeForm: 'Corrigindo Y' },
        { content: 'Rodar testes', status: 'pending', activeForm: 'Rodando os testes' }
      ])
    )
    await waitFor(() => expect(document.querySelector('.todo-plan-card')).toBeTruthy())
    expect(screen.getByText('Corrigindo X')).toBeTruthy()
    // 0 itens completed ainda (1 in_progress + 2 pending).
    expect(screen.getByText('0/3')).toBeTruthy()
    expect(document.querySelectorAll('.todo-plan-dot')).toHaveLength(3)

    // Avança — MESMO card atualiza (não duplica: continua só 1 .todo-plan-card).
    await emit(
      todoWriteEvent([
        { content: 'Corrigir X', status: 'completed', activeForm: 'Corrigindo X' },
        { content: 'Corrigir Y', status: 'in_progress', activeForm: 'Corrigindo Y' },
        { content: 'Rodar testes', status: 'pending', activeForm: 'Rodando os testes' }
      ])
    )
    await waitFor(() => expect(screen.getByText('Corrigindo Y')).toBeTruthy())
    expect(document.querySelectorAll('.todo-plan-card')).toHaveLength(1)
    // 1 item completed agora ("Corrigir X").
    expect(screen.getByText('1/3')).toBeTruthy()

    // Turno termina — card recolhe (resumo), continua visível.
    await emit(result)
    await waitFor(() => expect(screen.getByText('1/3 concluído')).toBeTruthy())
    expect(document.querySelector('.todo-plan-card')).toBeTruthy() // nunca some
    expect(document.querySelector('.todo-plan-card .spinner')).toBeNull() // spinner parou
  })

  it('trocar de conversa mostra o todoPlan da conversa nova (ou nenhum card, se ela nunca usou TodoWrite)', async () => {
    const conv2 = {
      id: 'c2',
      title: 'Conversa 2',
      cwd: '/proj2',
      model: 'claude-opus-4-8',
      sdkSessionId: null,
      messages: [],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: 1,
      updatedAt: 2
    }
    const seeded = JSON.parse(localStorage.getItem('agentcode.conversations.v1') || '[]')
    localStorage.setItem('agentcode.conversations.v1', JSON.stringify([...seeded, conv2]))

    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('tarefa complexa na conversa 1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    await emit(todoWriteEvent([{ content: 'Passo 1', status: 'in_progress', activeForm: 'Fazendo o passo 1' }]))
    await waitFor(() => expect(document.querySelector('.todo-plan-card')).toBeTruthy())

    // Troca pra Conversa 2 (nunca usou TodoWrite) — o card some, sem vazar o da c1.
    // Duas entradas na sidebar mostram "Conversa 2" (o próprio projeto + a
    // conversa dentro dele) — clicar em qualquer uma seleciona a conversa.
    fireEvent.click(screen.getAllByText('Conversa 2')[0])
    await waitFor(() => expect(document.querySelector('.todo-plan-card')).toBeNull())
  })

  it('expandir o card numa conversa não deixa o card da OUTRA conversa nascer já aberto', async () => {
    const conv2 = {
      id: 'c2',
      title: 'Conversa 2',
      cwd: '/proj2',
      model: 'claude-opus-4-8',
      sdkSessionId: null,
      messages: [],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: 1,
      updatedAt: 2
    }
    const seeded = JSON.parse(localStorage.getItem('agentcode.conversations.v1') || '[]')
    localStorage.setItem('agentcode.conversations.v1', JSON.stringify([...seeded, conv2]))

    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('tarefa complexa na conversa 1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    await emit(todoWriteEvent([{ content: 'Passo 1 da conversa 1', status: 'in_progress', activeForm: 'Fazendo o passo 1' }]))
    await waitFor(() => expect(document.querySelector('.todo-plan-card')).toBeTruthy())

    // Expande o card da conversa 1 — a lista completa fica visível.
    fireEvent.click(screen.getByRole('button', { name: /Fazendo o passo 1/ }))
    await waitFor(() => expect(screen.getByText('Passo 1 da conversa 1')).toBeTruthy())

    // Troca pra conversa 2 e dá a ela seu PRÓPRIO todoPlan (também ativo).
    fireEvent.click(screen.getAllByText('Conversa 2')[0])
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1)) // ainda não mandou nada na c2
    fireEvent.change(await screen.findByPlaceholderText(/Mensagem para o Claude/i), { target: { value: 'tarefa na c2' } })
    fireEvent.keyDown(screen.getByPlaceholderText(/Mensagem para o Claude/i), { key: 'Enter' })
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(2))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(2))
    await emit(
      {
        kind: 'tool-use',
        id: 'tw-c2',
        name: 'TodoWrite',
        input: { todos: [{ content: 'Passo 1 da conversa 2', status: 'in_progress', activeForm: 'Fazendo outra coisa' }] },
        parentToolUseId: null
      },
      'c2'
    )

    // O card da c2 deve nascer FECHADO — o texto completo do item não aparece
    // até o usuário clicar, mesmo tendo expandido o card da c1 antes.
    await waitFor(() => expect(screen.getByText('Fazendo outra coisa')).toBeTruthy())
    expect(screen.queryByText('Passo 1 da conversa 2')).toBeNull()
  })
})

// TaskCreate/TaskUpdate: the pair actually used in practice today (see
// App.tsx) — TodoWrite above is kept working but real sessions don't call it.
// Unlike TodoWrite, the task id isn't in TaskCreate's input: it only shows up
// in the matching tool-result text ("Task #N created successfully: ...").
const taskCreateEvent = (id: string, subject: string, activeForm?: string): ChatEvent => ({
  kind: 'tool-use',
  id,
  name: 'TaskCreate',
  input: activeForm ? { subject, activeForm } : { subject },
  parentToolUseId: null
})

const taskCreatedResult = (toolUseId: string, taskId: string, subject: string): ChatEvent => ({
  kind: 'tool-result',
  id: `${toolUseId}-res`,
  toolUseId,
  isError: false,
  text: `Task #${taskId} created successfully: ${subject}`
})

const taskUpdateEvent = (id: string, taskId: string, patch: Record<string, unknown>): ChatEvent => ({
  kind: 'tool-use',
  id,
  name: 'TaskUpdate',
  input: { taskId, ...patch },
  parentToolUseId: null
})

describe('App — TaskCreate/TaskUpdate também vira um plano fixo, não um card no feed de mensagens', () => {
  it('TaskCreate + resultado + TaskUpdate não aparecem no feed e atualizam o todoPlan persistido', async () => {
    // createdAt precisa ser recente: compactOldConversations (storage.ts) filtra
    // pra só user/assistant-answer em conversas com mais de 15 dias, e o seed
    // padrão do beforeEach (createdAt: 1) sempre cai nessa regra — o que deixaria
    // a checagem de "mensagem órfã" abaixo cega ao bug (o tool-result some do
    // save de qualquer forma, tenha ou não o vazamento).
    const seeded = JSON.parse(localStorage.getItem('agentcode.conversations.v1') || '[]')
    seeded[0].createdAt = Date.now()
    localStorage.setItem('agentcode.conversations.v1', JSON.stringify(seeded))

    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(taskCreateEvent('call1', 'Passo 1', 'Fazendo o passo 1'))
    await emit(taskCreatedResult('call1', '1', 'Passo 1'))
    await emit(taskCreateEvent('call2', 'Passo 2', 'Fazendo o passo 2'))
    await emit(taskCreatedResult('call2', '2', 'Passo 2'))
    await emit(taskUpdateEvent('u1', '1', { status: 'in_progress' }))

    // Nenhum ToolCard de TaskCreate/TaskUpdate no feed.
    expect(screen.queryByText('TaskCreate')).toBeNull()
    expect(screen.queryByText('TaskUpdate')).toBeNull()

    await waitFor(() => {
      const conv = savedConv() as
        | { todoPlan?: { items: TodoItem[]; active: boolean }; messages?: { kind: string }[] }
        | undefined
      const plan = conv?.todoPlan
      expect(plan?.active).toBe(true)
      expect(plan?.items).toEqual([
        { id: '1', content: 'Passo 1', status: 'in_progress', activeForm: 'Fazendo o passo 1' },
        { id: '2', content: 'Passo 2', status: 'pending', activeForm: 'Fazendo o passo 2' }
      ])
      // Nem mensagem órfã de resultado (o tool-use que ela pertence foi
      // desviado do feed, nunca entrou em `prev`) — lido no mesmo `waitFor`
      // pra esperar o save debounced persistir antes de checar o localStorage.
      expect((conv?.messages ?? []).some((m) => m.kind === 'tool-result')).toBe(false)
    })
  })

  it('TaskUpdate faz PATCH por id (não duplica, não mexe nos outros itens)', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(taskCreateEvent('c1', 'Passo 1', 'Fazendo o passo 1'))
    await emit(taskCreatedResult('c1', '1', 'Passo 1'))
    await emit(taskCreateEvent('c2', 'Passo 2', 'Fazendo o passo 2'))
    await emit(taskCreatedResult('c2', '2', 'Passo 2'))
    await waitFor(() => expect(savedConv()?.todoPlan?.items).toHaveLength(2))

    await emit(taskUpdateEvent('u1', '1', { status: 'completed' }))
    await emit(taskUpdateEvent('u2', '2', { status: 'in_progress' }))

    await waitFor(() => {
      const plan = savedConv()?.todoPlan
      expect(plan?.items).toHaveLength(2) // não virou 4
      expect(plan?.items[0].status).toBe('completed')
      expect(plan?.items[1].status).toBe('in_progress')
    })
  })

  it('status "deleted" remove o item certo da lista', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(taskCreateEvent('c1', 'Passo 1'))
    await emit(taskCreatedResult('c1', '1', 'Passo 1'))
    await emit(taskCreateEvent('c2', 'Passo 2'))
    await emit(taskCreatedResult('c2', '2', 'Passo 2'))
    await waitFor(() => expect(savedConv()?.todoPlan?.items).toHaveLength(2))

    await emit(taskUpdateEvent('u1', '1', { status: 'deleted' }))

    await waitFor(() => {
      const plan = savedConv()?.todoPlan
      expect(plan?.items).toHaveLength(1)
      expect(plan?.items[0].content).toBe('Passo 2')
    })
  })

  it('o turno terminar (result) marca active:false mesmo com itens ainda pendentes', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(taskCreateEvent('c1', 'Passo 1'))
    await emit(taskCreatedResult('c1', '1', 'Passo 1'))
    await emit(taskUpdateEvent('u1', '1', { status: 'completed' }))
    await emit(taskCreateEvent('c2', 'Passo 2'))
    await emit(taskCreatedResult('c2', '2', 'Passo 2'))
    await waitFor(() => expect(savedConv()?.todoPlan?.active).toBe(true))

    await emit(result) // turno termina — itens continuam como estavam

    await waitFor(() => {
      const plan = savedConv()?.todoPlan
      expect(plan?.active).toBe(false)
      expect(plan?.items).toHaveLength(2)
    })
  })

  it('input malformado (TaskCreate sem subject, TaskUpdate com taskId desconhecido) não derruba nem sobrescreve o plano', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(taskCreateEvent('c1', 'Passo 1'))
    await emit(taskCreatedResult('c1', '1', 'Passo 1'))
    await waitFor(() => expect(savedConv()?.todoPlan?.items).toHaveLength(1))

    // TaskCreate sem 'subject' — applyTaskCreate devolve null, plano intacto.
    await emit({ kind: 'tool-use', id: 'bad1', name: 'TaskCreate', input: { oops: true }, parentToolUseId: null })
    // TaskUpdate com taskId desconhecido — no-op.
    await emit(taskUpdateEvent('bad2', '999', { status: 'completed' }))

    expect(savedConv()?.todoPlan?.items).toHaveLength(1)
    expect(savedConv()?.todoPlan?.items[0].content).toBe('Passo 1')
    expect(savedConv()?.todoPlan?.items[0].status).toBe('pending')
  })

  it('TaskUpdate chegando antes do resultado do TaskCreate resolver o id é ignorado com segurança (sem crash)', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(taskCreateEvent('c1', 'Passo 1'))
    // Sem emitir o tool-result ainda — o id real "1" nunca foi resolvido.
    await emit(taskUpdateEvent('u1', '1', { status: 'completed' }))

    await waitFor(() => expect(savedConv()?.todoPlan?.items).toHaveLength(1))
    expect(savedConv()?.todoPlan?.items[0].status).toBe('pending') // no-op, não mudou
  })

  it('resultado de TaskCreate com erro (isError) remove o item pendente', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('faz uma tarefa complexa')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    await emit(taskCreateEvent('c1', 'Passo 1'))
    await waitFor(() => expect(savedConv()?.todoPlan?.items).toHaveLength(1))

    await emit({ kind: 'tool-result', id: 'c1-res', toolUseId: 'c1', isError: true, text: 'Error: task limit reached' })

    await waitFor(() => expect(savedConv()?.todoPlan?.items).toHaveLength(0))
  })
})

describe('App — TodoPlanCard renderizado de verdade via TaskCreate/TaskUpdate (end-to-end)', () => {
  it('card aparece fixo acima da composer, atualiza ao vivo, e recolhe quando o turno termina', async () => {
    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('corrige X e Y, com testes')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))

    // Sem TaskCreate ainda — nenhum card no DOM.
    expect(document.querySelector('.todo-plan-card')).toBeNull()

    await emit(taskCreateEvent('cA', 'Corrigir X', 'Corrigindo X'))
    await emit(taskCreatedResult('cA', '1', 'Corrigir X'))
    await emit(taskCreateEvent('cB', 'Corrigir Y', 'Corrigindo Y'))
    await emit(taskCreatedResult('cB', '2', 'Corrigir Y'))
    await emit(taskCreateEvent('cC', 'Rodar testes', 'Rodando os testes'))
    await emit(taskCreatedResult('cC', '3', 'Rodar testes'))
    await emit(taskUpdateEvent('u1', '1', { status: 'in_progress' }))

    await waitFor(() => expect(document.querySelector('.todo-plan-card')).toBeTruthy())
    expect(screen.getByText('Corrigindo X')).toBeTruthy()
    // 0 itens completed ainda.
    expect(screen.getByText('0/3')).toBeTruthy()
    expect(document.querySelectorAll('.todo-plan-dot')).toHaveLength(3)

    // Avança — MESMO card atualiza (não duplica: continua só 1 .todo-plan-card).
    await emit(taskUpdateEvent('u2', '1', { status: 'completed' }))
    await emit(taskUpdateEvent('u3', '2', { status: 'in_progress' }))

    await waitFor(() => expect(screen.getByText('Corrigindo Y')).toBeTruthy())
    expect(document.querySelectorAll('.todo-plan-card')).toHaveLength(1)
    expect(screen.getByText('1/3')).toBeTruthy()

    // Turno termina — card recolhe (resumo), continua visível.
    await emit(result)
    await waitFor(() => expect(screen.getByText('1/3 concluído')).toBeTruthy())
    expect(document.querySelector('.todo-plan-card')).toBeTruthy() // nunca some
    expect(document.querySelector('.todo-plan-card .spinner')).toBeNull() // spinner parou
  })

  it('trocar de conversa mostra o todoPlan da conversa nova (ou nenhum card, se ela nunca usou Task*)', async () => {
    const conv2 = {
      id: 'c2',
      title: 'Conversa 2',
      cwd: '/proj2',
      model: 'claude-opus-4-8',
      sdkSessionId: null,
      messages: [],
      tokens: { context: 0, output: 0, cost: 0 },
      createdAt: 1,
      updatedAt: 2
    }
    const seeded = JSON.parse(localStorage.getItem('agentcode.conversations.v1') || '[]')
    localStorage.setItem('agentcode.conversations.v1', JSON.stringify([...seeded, conv2]))

    render(
      <UiProvider>
        <App />
      </UiProvider>
    )
    await send('tarefa complexa na conversa 1')
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    await flushConnect()
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledTimes(1))
    await emit(taskCreateEvent('c1', 'Passo 1'))
    await emit(taskCreatedResult('c1', '1', 'Passo 1'))
    await waitFor(() => expect(document.querySelector('.todo-plan-card')).toBeTruthy())

    // Troca pra Conversa 2 (nunca usou Task*) — o card some, sem vazar o da c1.
    fireEvent.click(screen.getAllByText('Conversa 2')[0])
    await waitFor(() => expect(document.querySelector('.todo-plan-card')).toBeNull())
  })
})
