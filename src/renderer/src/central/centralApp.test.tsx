/**
 * A Central no App inteiro (Etapa 4 + Emenda A1): o id pré-definido chega à bolha
 * do destino (na hora e saindo da fila), a mensagem entregue pela Central não é
 * adotada de novo, todo turno deste PC é adotado (campo, dreno da fila, "agora",
 * celular, MCP; planejamento fora) e o "não era aqui" com o turno rodando para só
 * o turno — a fila da conversa sai depois.
 *
 * O painel da Central é um dublê (a tela completa é da Etapa 5): ele recebe o
 * controller REAL pela fábrica `centralPanel(conv)` do App.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AgentEventMsg, ChatEvent } from '@shared/ipc'
import type { CentralRequestEntry, CentralRouteRequest, CentralRouteResult } from '@shared/central'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'
import type { CentralController } from './useCentral'

configure({ asyncUtilTimeout: 10_000 })
window.HTMLElement.prototype.scrollIntoView = vi.fn()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

vi.mock('./CentralPanel', () => ({
  CentralPanel: (props: { controller?: CentralController; onSend: (t: string, i: [], th: [], f: [], r: []) => void }) => (
    <section aria-label="Central">
      <input aria-label="pedido" onKeyDown={(e) => e.key === 'Enter' && props.onSend((e.target as HTMLInputElement).value, [], [], [], [])} />
      {props.controller?.entries.map((e) =>
        e.kind === 'request' ? (
          <div key={e.id}>
            <button onClick={() => void props.controller?.notHere(e.id)}>{`não era aqui: ${e.text}`}</button>
          </div>
        ) : null
      )}
    </section>
  )
}))

type Stored = { id: string; cwd?: string; [k: string]: unknown }
const KEY = 'agentcode.conversations.v1'
const stored = (): Stored[] => JSON.parse(localStorage.getItem(KEY) || '[]')
const storedConv = (id: string) => stored().find((c) => c.id === id) as { messages: Array<{ kind: string; id: string; text: string; injected?: boolean; canceled?: boolean }> } | undefined
const centralRequests = (): CentralRequestEntry[] =>
  (((stored().find((c) => c.id === 'central') as { central?: { entries: CentralRequestEntry[] } } | undefined)?.central?.entries ?? []).filter((e) => e.kind === 'request'))

let agentCb: ((m: AgentEventMsg) => void) | null = null
let inboundCb: ((m: { convId: string; text: string }) => void) | null = null
let mcpCb: ((m: { taskId: string; convId: string; text: string }) => void) | null = null

const C1 = { kind: 'conversation' as const, convId: 'c1', cwd: '/proj', project: 'proj', title: 'Conversa', sandbox: false }

function installApi(route: (req: CentralRouteRequest) => CentralRouteResult) {
  agentCb = inboundCb = mcpCb = null
  const versioned = (payload: Stored) => ({ id: payload.id, payload, revision: 1, contentHash: JSON.stringify(payload), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() })
  const remote = { running: false, url: '', ip: '', port: 0, token: '', clients: 0, relayConnected: false }
  const fn = <T,>(v: T) => vi.fn(async () => v)
  const off = () => vi.fn(() => () => {})
  const api = {
    getConfig: fn({ voice: { voice: 'pf_dora', speed: 1 }, ollama: { enabled: false, apiKey: '' }, skipPermissions: false, windowsControlEnabled: false, remoteToken: '', remoteEnabled: false }),
    setConfig: fn(undefined), isTypeSafeConfigured: fn(true), onAppCloseRequested: off(), appCloseReady: fn(undefined), onAppReloadRequested: off(), appReloadReady: fn(undefined),
    getStorageStatus: fn({ backend: 'sqlite', state: 'sqlite-ready', writable: true, installationId: 'pc-teste', targetDatabase: 'agent-code', hasPassword: false }),
    onStorageStatusChanged: off(), onStorageFlushRequested: off(), storageFlushReady: fn(undefined), onStorageChanged: off(),
    countConversationsByProject: vi.fn(async () => {
      const by = new Map<string, number>()
      for (const c of stored()) by.set(c.cwd ?? '', (by.get(c.cwd ?? '') ?? 0) + 1)
      return [...by].map(([cwd, total]) => ({ cwd, total, updatedAt: new Date(0).toISOString() }))
    }),
    loadVersionedConversations: vi.fn(async (q?: { ids?: string[]; cwds?: string[] }) =>
      stored().filter((c) => (!q?.ids || q.ids.includes(c.id)) && (!q?.cwds || q.cwds.includes(c.cwd ?? ''))).map(versioned)),
    upsertConversation: vi.fn(async (input: { id: string; payload: Stored; expectedRevision?: number }) => {
      localStorage.setItem(KEY, JSON.stringify([...stored().filter((c) => c.id !== input.id), input.payload]))
      return { ...versioned(input.payload), revision: (input.expectedRevision ?? 0) + 1 }
    }),
    deleteConversation: vi.fn(async (input: { id: string; expectedRevision: number }) => ({ ...versioned({ id: input.id }), deletedAt: new Date().toISOString() })),
    onWindowsControlChanged: off(), setWindowsControlEnabled: fn(undefined), setChromeControlEnabled: fn(undefined), onChromeControlChanged: off(),
    getChromeBridgeStatus: fn({ listening: false, port: null, connected: false, extensionVersion: null, userAgent: null }), onChromeBridgeStatusChanged: off(),
    authStatus: fn({ authenticated: true }), codexStatus: fn({ connected: false }),
    sandboxInfo: fn({ root: 'C:\\local\\sandbox' }), sandboxCreate: fn({ path: 'C:\\local\\sandbox\\x' }),
    providersStatus: fn({ claude: true, gpt: false, ollama: false }), onProvidersChanged: off(),
    pathExists: fn(true), projectTree: fn({ nodes: [], truncated: false, missing: [] }),
    kvGet: vi.fn(async (key: string) => localStorage.getItem(key)), kvSet: vi.fn(async (key: string, value: string) => localStorage.setItem(key, value)),
    getCacheInfo: fn({ dir: '', dbPath: '', memoriesDir: '', skillsDir: '' }), getAppVersion: fn('test'),
    startAgent: fn({ ok: true }), sendMessage: fn(undefined), interrupt: fn({ stillQueued: [] }), injectNow: fn({ ok: true }),
    disposeAgent: fn(undefined), refreshUsage: fn(undefined), getTokenUsageHistory: fn({ calls: [], totals: [] }),
    onAgentEvent: vi.fn((cb: (m: AgentEventMsg) => void) => ((agentCb = cb), () => {})),
    onPermissionRequest: off(), onPermissionExpired: off(), onVigiaAlert: off(), onBoardChanged: off(),
    boardList: fn({ available: true, items: [] }), tasksBoard: fn({ available: false, items: [] }), boardDismiss: fn(null),
    respondPermission: fn(undefined), onPoProviderDiagnostic: off(), setActiveBrowser: fn(undefined), disposeBrowser: fn(undefined),
    newTab: fn(undefined), closeTab: fn(undefined), onBrowserFrame: off(), onBrowserState: off(), onBrowserPicked: off(), onAndroidProgress: off(),
    remoteStatus: fn(remote), publishRemoteState: fn(undefined),
    onRemoteInbound: vi.fn((cb: (m: { convId: string; text: string }) => void) => ((inboundCb = cb), () => {})),
    onMcpInbound: vi.fn((cb: (m: { taskId: string; convId: string; text: string }) => void) => ((mcpCb = cb), () => {})),
    mcpRendererReady: fn(undefined), mcpTaskFailed: fn(undefined),
    onRemoteSetSkipPerms: off(), onRemoteSetModel: off(), onRemoteRecoveryAction: off(), onRemotePermissionResponse: off(),
    onRemoteInterrupt: off(), onRemoteSetMode: off(), onRemoteConversationAction: off(), onRemoteClients: off(),
    centralRoute: vi.fn(async (req: CentralRouteRequest) => route(req)), centralCorrection: fn(undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

const conv = (id: string, title: string, cwd: string, extra: Record<string, unknown> = {}): Stored => ({
  id, title, cwd, model: 'claude-opus-4-8', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: 1, updatedAt: 2, ...extra
})
const toC1 = (req: CentralRouteRequest): CentralRouteResult =>
  req.forceAsk ? { kind: 'ask', options: [{ target: { kind: 'new-sandbox' } }], reason: 'moved' } : { kind: 'direct', target: C1, rule: 'continua', confidence: 0.9, why: 'continua “Conversa”' }

async function emit(event: ChatEvent, convId = 'c1'): Promise<void> {
  await act(async () => agentCb?.({ convId, event }))
}
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: 'ok', durationMs: 1 }

async function typeInConversation(text: string): Promise<void> {
  const box = (await screen.findByPlaceholderText(/Mensagem para o Claude/i)) as HTMLTextAreaElement
  await waitFor(() => expect(box.disabled).toBe(false))
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}
async function sendInCentral(text: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Central.*fale com o agent/ }))
  const box = await screen.findByRole('textbox', { name: 'pedido' })
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}
const sentTexts = (api: ReturnType<typeof installApi>): string[] => api.sendMessage.mock.calls.map((c: unknown[]) => c[1] as string)

let api: ReturnType<typeof installApi>
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem(KEY, JSON.stringify([conv('c1', 'Conversa', '/proj'), conv('p1', 'Plano', '/proj', { mode: 'planning', planningSlug: 'plano-x' })]))
  localStorage.setItem('agentcode.ui.v1', JSON.stringify({ collapsed: false, activeId: 'c1', browserMinimized: true }))
  api = installApi(toC1)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('id pré-definido (âncora da Central) até a bolha do destino', () => {
  it('saindo na hora: a bolha do destino tem o id da âncora; a entrega não é adotada de novo', async () => {
    render(<UiProvider><App /></UiProvider>)
    await sendInCentral('o botão ficou torto')
    await waitFor(() => expect(sentTexts(api)).toEqual(['o botão ficou torto']))
    await waitFor(() => expect(storedConv('c1')?.messages.length).toBe(1))
    await waitFor(() => expect(centralRequests()[0]?.anchor?.msgId).toBe(storedConv('c1')!.messages[0].id))
    expect(centralRequests()).toHaveLength(1)
    expect(centralRequests()[0]).toMatchObject({ origin: 'central', device: 'pc-teste', state: 'delivered' })
  })

  it('saindo da fila: a conversa ocupada guarda o id; no fim do turno a bolha nasce com ele', async () => {
    render(<UiProvider><App /></UiProvider>)
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await sendInCentral('segunda, pela Central')
    await waitFor(() => expect(centralRequests().find((e) => e.origin === 'central')?.state).toBe('delivered'))
    expect(sentTexts(api)).toEqual(['primeira'])
    await emit(result)
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda, pela Central']))
    const routed = centralRequests().find((e) => e.origin === 'central')!
    await waitFor(() => expect(storedConv('c1')?.messages.map((m) => m.id)).toContain(routed.anchor!.msgId))
    expect(centralRequests().map((e) => e.origin)).toEqual(['conversation', 'central'])
  })
})

describe('adoção de todo turno deste PC (Emenda A1)', () => {
  it('campo, dreno da fila, "agora", celular e MCP entram na Central; o planejamento não', async () => {
    render(<UiProvider><App /></UiProvider>)
    await typeInConversation('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await typeInConversation('segunda')
    await typeInConversation('terceira')
    fireEvent.click((await screen.findAllByRole('button', { name: 'agora' }))[1])
    await waitFor(() => expect(api.injectNow).toHaveBeenCalled())
    await emit(result)
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda']))
    await emit(result)
    await act(async () => inboundCb?.({ convId: 'c1', text: 'do celular' }))
    await waitFor(() => expect(sentTexts(api)).toContain('do celular'))
    await emit(result)
    await act(async () => mcpCb?.({ taskId: 't1', convId: 'c1', text: 'tarefa mcp' }))
    await waitFor(() => expect(sentTexts(api)).toContain('tarefa mcp'))
    await act(async () => inboundCb?.({ convId: 'p1', text: 'para o plano' }))
    await waitFor(() => expect(sentTexts(api)).toContain('para o plano'))
    await waitFor(() =>
      expect(centralRequests().map((e) => [e.text, e.injected === true])).toEqual([
        ['primeira', false],
        ['terceira', true],
        ['segunda', false],
        ['do celular', false],
        ['tarefa mcp', false]
      ])
    )
    const bubbles = storedConv('c1')!.messages
    for (const e of centralRequests()) {
      expect(e).toMatchObject({ origin: 'conversation', state: 'delivered', device: 'pc-teste', route: { target: { convId: 'c1' }, why: 'enviada na própria conversa' } })
      expect(bubbles.find((m) => m.id === e.anchor?.msgId)?.text).toBe(e.text)
    }
    expect(centralRequests().some((e) => e.anchor?.convId === 'p1' || e.anchor?.convId === 'central')).toBe(false)
  })
})

describe('"não era aqui" com o turno rodando (Stop que mantém a fila)', () => {
  it('para só o turno; no fim dele a próxima da fila sai com o id dela', async () => {
    render(<UiProvider><App /></UiProvider>)
    await sendInCentral('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await sendInCentral('segunda')
    await waitFor(() => expect(centralRequests()[1]?.state).toBe('delivered'))
    fireEvent.click(await screen.findByRole('button', { name: 'não era aqui: primeira' }))
    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(centralRequests()[0]).toMatchObject({ state: 'asking', movedFrom: C1, ask: { reason: 'moved' } }))
    expect(sentTexts(api)).toEqual(['primeira'])
    await emit(result)
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda']))
    const second = centralRequests()[1]
    await waitFor(() => expect(storedConv('c1')?.messages.map((m) => m.id)).toContain(second.anchor!.msgId))
    expect(storedConv('c1')!.messages[0]).toMatchObject({ text: 'primeira', canceled: true })
  })

  it('sem o fim do turno (o Stop pegou antes de começar): a fila sai sozinha depois do recibo', async () => {
    render(<UiProvider><App /></UiProvider>)
    await sendInCentral('primeira')
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira']))
    await sendInCentral('segunda')
    await waitFor(() => expect(centralRequests()[1]?.state).toBe('delivered'))
    fireEvent.click(await screen.findByRole('button', { name: 'não era aqui: primeira' }))
    await waitFor(() => expect(api.interrupt).toHaveBeenCalledWith('c1'))
    await waitFor(() => expect(sentTexts(api)).toEqual(['primeira', 'segunda']), { timeout: 8_000 })
  })
})
