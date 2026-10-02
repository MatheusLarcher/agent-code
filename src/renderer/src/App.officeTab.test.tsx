/**
 * O App com a aba Escritório: as trocas de aba e o que precisa sair do 3D. O
 * Escritório 3D em si (three, WebGL) fica de fora — um dublê no lugar do
 * Office3DWorkspace guarda as props que o App passa e mostra o chat que recebe,
 * como o de verdade. O window.api é o mesmo dublê do App.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AgentEventMsg, ChatEvent } from '@shared/ipc'
import { App } from './App'
import type { Office3DWorkspaceProps } from './office3d/Office3DWorkspace'
import { makePlan } from './planning/planningTestUtils'
import { UiProvider } from './ui/UiProvider'

configure({ asyncUtilTimeout: 10_000 })

const office = vi.hoisted(() => ({ props: null as Office3DWorkspaceProps | null, fail: false }))
vi.mock('./office3d/Office3DWorkspace', () => ({
  Office3DWorkspace: (p: Office3DWorkspaceProps) => {
    office.props = p
    if (office.fail) throw new Error('WebGL sumiu')
    return (
      <div data-testid="office-stub" hidden={!p.active}>
        {p.active ? p.chat : null}
      </div>
    )
  }
}))

window.HTMLElement.prototype.scrollIntoView = vi.fn()
// O jsdom não tem CSS.escape (o MessageList acha a mensagem do resultado de busca por ele).
if (!globalThis.CSS?.escape) (globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = { escape: (s) => s.replace(/["\\]/g, '\\$&') }
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let agentEventCb: ((m: AgentEventMsg) => void) | null = null

/** O window.api do App.test.tsx (conversas no localStorage), com o Quadro e o Planejamento. */
function installApi(): Record<string, ReturnType<typeof vi.fn>> {
  agentEventCb = null
  const versioned = (payload: { id: string }) => ({
    id: payload.id,
    payload,
    revision: 1,
    contentHash: JSON.stringify(payload),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  })
  const stored = (): Array<{ id: string }> => JSON.parse(localStorage.getItem('agentcode.conversations.v1') || '[]')
  const remote = { running: false, url: '', ip: '', port: 0, token: '', clients: 0, relayConnected: false }
  const plan = (slug: string) => makePlan({ slug, roteiro: { titulo: 'Checkout com Pix', etapas: [] }, cards: [] })
  const api = {
    getConfig: vi.fn(async () => ({
      voice: { voice: 'pf_dora', speed: 1 },
      ollama: { enabled: false, apiKey: '' },
      skipPermissions: false,
      windowsControlEnabled: false,
      remoteToken: '',
      remoteEnabled: false,
      vigia: { enabled: true, model: 'claude-sonnet-5-5' }
    })),
    setConfig: vi.fn(async () => {}),
    isTypeSafeConfigured: vi.fn(async () => true),
    onAppCloseRequested: vi.fn(() => () => {}),
    appCloseReady: vi.fn(async () => {}),
    onAppReloadRequested: vi.fn(() => () => {}),
    appReloadReady: vi.fn(async () => {}),
    getStorageStatus: vi.fn(async () => ({
      backend: 'sqlite',
      state: 'sqlite-ready',
      writable: true,
      installationId: '00000000-0000-4000-8000-000000000001',
      targetDatabase: 'agent-code',
      hasPassword: false
    })),
    onStorageStatusChanged: vi.fn(() => () => {}),
    onStorageFlushRequested: vi.fn(() => () => {}),
    storageFlushReady: vi.fn(async () => {}),
    onStorageChanged: vi.fn(() => () => {}),
    countConversationsByProject: vi.fn(async () => []),
    loadVersionedConversations: vi.fn(async () => stored().map(versioned)),
    upsertConversation: vi.fn(async (input: { id: string; payload: { id: string }; expectedRevision?: number }) => {
      localStorage.setItem('agentcode.conversations.v1', JSON.stringify([...stored().filter((c) => c.id !== input.id), input.payload]))
      return { ...versioned(input.payload), revision: (input.expectedRevision ?? 0) + 1 }
    }),
    deleteConversation: vi.fn(async (input: { id: string; expectedRevision: number }) => {
      const payload = stored().find((c) => c.id === input.id) ?? { id: input.id }
      localStorage.setItem('agentcode.conversations.v1', JSON.stringify(stored().filter((c) => c.id !== input.id)))
      return { ...versioned(payload), revision: input.expectedRevision + 1, deletedAt: new Date().toISOString() }
    }),
    setWindowsControlEnabled: vi.fn(async () => {}),
    onWindowsControlChanged: vi.fn(() => () => {}),
    setChromeControlEnabled: vi.fn(async () => {}),
    onChromeControlChanged: vi.fn(() => () => {}),
    getChromeBridgeStatus: vi.fn(async () => ({ listening: false, port: null, connected: false, extensionVersion: null, userAgent: null })),
    onChromeBridgeStatusChanged: vi.fn(() => () => {}),
    authStatus: vi.fn(async () => ({ authenticated: true })),
    authLogin: vi.fn(async () => ({ ok: true })),
    codexStatus: vi.fn(async () => ({ connected: false })),
    sandboxInfo: vi.fn(async () => ({ root: 'C:\\local\\sandbox' })),
    sandboxCreate: vi.fn(async () => ({ path: 'C:\\local\\sandbox\\2026-09-29_10-00_abcd' })),
    providersStatus: vi.fn(async () => ({ claude: true, gpt: false, ollama: false })),
    onProvidersChanged: vi.fn(() => () => {}),
    pathExists: vi.fn(async () => true),
    projectTree: vi.fn(async () => ({ nodes: [], truncated: false, missing: [] })),
    pickDirectory: vi.fn(async () => null),
    kvGet: vi.fn(async (key: string) => localStorage.getItem(key)),
    kvSet: vi.fn(async (key: string, value: string) => localStorage.setItem(key, value)),
    getCacheInfo: vi.fn(async () => ({ dir: '', dbPath: '', memoriesDir: '', skillsDir: '' })),
    getAppVersion: vi.fn(async () => 'test'),
    startAgent: vi.fn(() => new Promise<{ ok: boolean }>(() => {})),
    sendMessage: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ stillQueued: [] })),
    respondPermission: vi.fn(async () => {}),
    disposeAgent: vi.fn(async () => {}),
    refreshUsage: vi.fn(async () => {}),
    getTokenUsageHistory: vi.fn(async () => ({ calls: [], totals: [] })),
    onAgentEvent: vi.fn((cb: (m: AgentEventMsg) => void) => {
      agentEventCb = cb
      return () => {}
    }),
    onPermissionRequest: vi.fn(() => () => {}),
    onPermissionExpired: vi.fn(() => () => {}),
    onVigiaAlert: vi.fn(() => () => {}),
    onPoProviderDiagnostic: vi.fn(() => () => {}),
    onBoardChanged: vi.fn(() => () => {}),
    boardList: vi.fn(async () => ({ available: true, items: [] })),
    tasksBoard: vi.fn(async () => ({ available: false, items: [] })),
    boardDismiss: vi.fn(async () => null),
    setActiveBrowser: vi.fn(async () => {}),
    disposeBrowser: vi.fn(async () => {}),
    newTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    onBrowserFrame: vi.fn(() => () => {}),
    onBrowserState: vi.fn(() => () => {}),
    onBrowserPicked: vi.fn(() => () => {}),
    onAndroidProgress: vi.fn(() => () => {}),
    remoteStatus: vi.fn(async () => remote),
    publishRemoteState: vi.fn(async () => {}),
    onRemoteInbound: vi.fn(() => () => {}),
    onRemoteSetSkipPerms: vi.fn(() => () => {}),
    onRemoteSetModel: vi.fn(() => () => {}),
    onRemoteRecoveryAction: vi.fn(() => () => {}),
    onRemotePermissionResponse: vi.fn(() => () => {}),
    onRemoteInterrupt: vi.fn(() => () => {}),
    onRemoteSetMode: vi.fn(() => () => {}),
    onRemoteConversationAction: vi.fn(() => () => {}),
    onRemoteBuildProgress: vi.fn(() => () => {}),
    onRemoteClients: vi.fn(() => () => {}),
    planningOpen: vi.fn(async (req: { slug: string }) => ({ ok: true, plan: plan(req.slug) })),
    planningClose: vi.fn(async () => ({ ok: true })),
    onPlanningChanged: vi.fn(() => () => {}),
    planningList: vi.fn(async () => ({ ok: true, slugs: [] })),
    planningCreate: vi.fn(async (req: { slug: string }) => ({ ok: true, plan: plan(req.slug) }))
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

let api: Record<string, ReturnType<typeof vi.fn>>

const conv = (id: string, title: string, messages: unknown[] = []) => ({
  id,
  title,
  cwd: '/proj',
  model: 'claude-opus-4-8',
  sdkSessionId: null,
  messages,
  tokens: { context: 0, output: 0, cost: 0 },
  createdAt: 1,
  updatedAt: 2
})

function seed(list: unknown[], tab: 'chat' | 'office' = 'chat'): void {
  localStorage.setItem('agentcode.conversations.v1', JSON.stringify(list))
  localStorage.setItem('agentcode.ui.v1', JSON.stringify({ collapsed: false, activeId: 'c1', browserMinimized: false }))
  localStorage.setItem('agentcode.mainTab', tab)
}

async function emit(event: ChatEvent, convId = 'c1'): Promise<void> {
  await act(async () => {
    agentEventCb?.({ convId, event })
  })
}

const tab = (name: RegExp): HTMLElement => screen.getByRole('tab', { name })
const selected = (name: RegExp): string | null => tab(name).getAttribute('aria-selected')

beforeEach(() => {
  localStorage.clear()
  office.props = null
  office.fail = false
  seed([conv('c1', 'Conversa')])
  api = installApi()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('App — aba Escritório', () => {
  it('"Novo planejamento" com o Escritório aberto mostra a Tela de Planejamento (volta para a aba Conversa)', async () => {
    seed([conv('c1', 'Conversa')], 'office')
    render(<UiProvider><App /></UiProvider>)
    await screen.findByTestId('office-stub')
    expect(selected(/Escritório/)).toBe('true')

    fireEvent.click(await screen.findByRole('button', { name: 'Novo planejamento' }))
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Criar planejamento' }))
    await waitFor(() => expect(api.planningCreate).toHaveBeenCalledTimes(1))

    expect(await screen.findByRole('heading', { name: 'Checkout com Pix' })).toBeTruthy()
    expect(selected(/Conversa/)).toBe('true')
    expect(localStorage.getItem('agentcode.mainTab')).toBe('chat')
    expect(office.props?.active).toBe(false)
  })

  it('o Quadro só conta como aberto na aba Conversa: sem scan de disco nem botão aceso com o Escritório; o botão leva de volta', async () => {
    const { container } = render(<UiProvider><App /></UiProvider>)
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    const quadro = screen.getByTitle('Quadro: tarefas e quem está trabalhando nesta conversa')
    fireEvent.click(quadro)
    await waitFor(() => expect(api.projectTree).toHaveBeenCalledTimes(1))
    expect(quadro.classList.contains('on')).toBe(true)

    fireEvent.click(tab(/Escritório/))
    await screen.findByTestId('office-stub')
    expect(quadro.classList.contains('on')).toBe(false)
    expect(container.querySelector('.right-pane')).toBeNull()
    // Atividade na conversa (o que re-escanearia o projeto com o Quadro aberto): nada de scan.
    await emit({ kind: 'assistant-text', id: 'a1', text: 'mexi nos arquivos', final: true })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(api.projectTree).toHaveBeenCalledTimes(1)

    // O botão do Quadro, com o Escritório aberto, abre o Quadro (na aba Conversa).
    fireEvent.click(quadro)
    expect(selected(/Conversa/)).toBe('true')
    expect(quadro.classList.contains('on')).toBe(true)
    await waitFor(() => expect(api.projectTree).toHaveBeenCalledTimes(2))
  })

  it('trocar de aba não reaplica a busca antiga: a mensagem não volta a centralizar nem piscar', async () => {
    seed([conv('c1', 'Conversa', [{ kind: 'user', id: 'm1', text: 'preciso do orçamento do cliente' }])])
    const centered = (): number =>
      vi.mocked(window.HTMLElement.prototype.scrollIntoView).mock.calls.filter(([arg]) => (arg as ScrollIntoViewOptions | undefined)?.block === 'center').length
    const { container } = render(<UiProvider><App /></UiProvider>)
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    vi.mocked(window.HTMLElement.prototype.scrollIntoView).mockClear()

    fireEvent.change(screen.getByPlaceholderText('Buscar conversas ou projetos…'), { target: { value: 'orçamento' } })
    fireEvent.click(await waitFor(() => container.querySelector('.conv-row') as HTMLElement))
    await waitFor(() => expect(centered()).toBe(1))
    expect(container.querySelector('[data-mid="m1"]')?.classList.contains('msg-flash')).toBe(true)

    fireEvent.click(tab(/Escritório/))
    const stub = await screen.findByTestId('office-stub')
    await waitFor(() => expect(within(stub).getByPlaceholderText(/Mensagem para o Claude/i)).toBeTruthy())
    expect(stub.querySelector('[data-mid="m1"]')?.classList.contains('msg-flash')).toBe(false)
    fireEvent.click(tab(/Conversa/))
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    expect(container.querySelector('[data-mid="m1"]')?.classList.contains('msg-flash')).toBe(false)
    expect(centered()).toBe(1)
  })

  it('o App liga o balão de pedido ao focusRequest e o aviso do Controle do Windows ao mesmo "Desativar" do chat', async () => {
    seed([conv('c1', 'Conversa'), conv('c2', 'Outra')], 'office')
    const base = await (api.getConfig as () => Promise<Record<string, unknown>>)()
    api.getConfig.mockResolvedValue({ ...base, windowsControlEnabled: true })
    render(<UiProvider><App /></UiProvider>)
    await screen.findByTestId('office-stub')
    await waitFor(() => expect(office.props?.windowsControlEnabled).toBe(true))

    act(() => office.props?.onFocusRequest?.('c2'))
    await waitFor(() => expect(office.props?.conversation?.id).toBe('c2'))
    expect(selected(/Escritório/)).toBe('true')

    act(() => office.props?.onDisableWindowsControl?.())
    await waitFor(() => expect(api.setWindowsControlEnabled).toHaveBeenCalledWith(false))
    await waitFor(() => expect(office.props?.windowsControlEnabled).toBe(false))
  })

  it('uma falha no 3D vira um aviso com "Voltar para a Conversa" (o app continua de pé)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    office.fail = true
    seed([conv('c1', 'Conversa')], 'office')
    render(<UiProvider><App /></UiProvider>)
    expect((await screen.findByRole('alert')).textContent).toContain('O Escritório 3D falhou: WebGL sumiu')
    expect(localStorage.getItem('agentcode.mainTab')).toBe('chat')
    fireEvent.click(screen.getByRole('button', { name: 'Voltar para a Conversa' }))
    expect(selected(/Conversa/)).toBe('true')
    expect(await screen.findByPlaceholderText(/Mensagem para o Claude/i)).toBeTruthy()
  })
})
