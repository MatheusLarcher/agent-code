/**
 * O App com a aba Escritório: as trocas de aba e o que precisa sair do 3D. O
 * Escritório 3D em si (three, WebGL) fica de fora — um dublê no lugar do
 * Office3DWorkspace guarda as props que o App passa e mostra o chat que recebe,
 * como o de verdade. O window.api é o mesmo dublê do App.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement, type ReactElement } from 'react'
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AgentEventMsg, ChatEvent } from '@shared/ipc'
import { App } from './App'
import { CentralPanel, type CentralPanelProps } from './central/CentralPanel'
import type { TtsControls } from './components/ChatRows'
import type { Office3DWorkspaceProps } from './office3d/Office3DWorkspace'
import { makePlan } from './planning/planningTestUtils'
import { UiProvider } from './ui/UiProvider'
import { syncIntoLocalStorage } from './conversationSyncFake'

configure({ asyncUtilTimeout: 10_000 })

const office = vi.hoisted(() => ({ props: null as Office3DWorkspaceProps | null, fail: false, monitor: false, pickerFor: null as string | null, tts: null as TtsControls | null }))
vi.mock('./office3d/Office3DWorkspace', async () => {
  const { useContext } = await import('react')
  const { TtsContext } = await import('./components/ttsContext')
  return { Office3DWorkspace: (p: Office3DWorkspaceProps) => {
    office.props = p
    // O TTS que o App põe em volta do Escritório (o "Ouvir" do Chat da tela do monitor o lê daqui).
    office.tts = useContext(TtsContext)
    if (office.fail) throw new Error('WebGL sumiu')
    return (
      <div data-testid="office-stub" hidden={!p.active}>
        {p.active ? p.chat : null}
        {/* A tela do monitor focado (só quando o teste a abre). */}
        {p.active && office.monitor ? <div data-testid="office-monitor-stub">{p.monitorComposer}</div> : null}
        {/* O seletor de modelo da tela, para a conversa do agente focado (só quando o teste o pede). */}
        {p.active && office.pickerFor ? <div data-testid="office-picker-stub">{p.monitorModelPicker?.(office.pickerFor)}</div> : null}
      </div>
    )
  } }
})

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
    syncConversations: vi.fn(syncIntoLocalStorage('agentcode.conversations.v1')),
    flushConversations: vi.fn(async () => true),
    getConversationSaveStatus: vi.fn(async () => ({ state: 'saved', pending: 0, oldestMs: 0 })),
    onConversationSaveStatus: vi.fn(() => () => {}),
    onConversationResync: vi.fn(() => () => {}),
    onCentralRemote: vi.fn(() => () => {}),
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
    listContextTurns: vi.fn(async () => []),
    readContextTurn: vi.fn(async () => null),
    countContextExact: vi.fn(async () => ({ ok: false, usage: null })),
    // O TTS (Kokoro) no teste: não sintetiza nada.
    speak: vi.fn(async () => ({ ok: false, error: 'sem voz no teste' })),
    revealSecret: vi.fn(async () => null),
    onContextTurnsChanged: vi.fn(() => () => {}),
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
    onRemoteCentralChoose: vi.fn(() => () => {}),
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
  office.monitor = false
  office.pickerFor = null
  office.tts = null
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

    // Uma Tela de Planejamento só: no Escritório ela vai para a TV (prop `planning`) e sai da aba Conversa.
    expect(office.props?.planning ?? null).toBeNull()
    fireEvent.click(tab(/Escritório/))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Checkout com Pix' })).toBeNull())
    expect(isValidElement(office.props?.planning)).toBe(true)
    fireEvent.click(tab(/Conversa/))
    expect(await screen.findByRole('heading', { name: 'Checkout com Pix' })).toBeTruthy()
    expect(office.props?.planning ?? null).toBeNull()
  })

  it('o Quadro só conta como aberto na aba Conversa: sem scan de disco com o Escritório; volta aberto na Conversa', async () => {
    const { container } = render(<UiProvider><App /></UiProvider>)
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    fireEvent.click(screen.getByTitle('Quadro: as tarefas do projeto e quem está trabalhando em cada uma'))
    await waitFor(() => expect(api.projectTree).toHaveBeenCalledTimes(1))

    fireEvent.click(tab(/Escritório/))
    await screen.findByTestId('office-stub')
    expect(container.querySelector('.right-pane')).toBeNull()
    // Atividade na conversa (o que re-escanearia o projeto com o Quadro aberto): nada de scan.
    await emit({ kind: 'assistant-text', id: 'a1', text: 'mexi nos arquivos', final: true })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(api.projectTree).toHaveBeenCalledTimes(1)

    // De volta à Conversa, o Quadro continua aberto e volta a escanear.
    fireEvent.click(tab(/Conversa/))
    await waitFor(() => expect(api.projectTree).toHaveBeenCalledTimes(2))
    expect(container.querySelector('.pane-tab.on')?.textContent).toContain('Quadro')
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

  it('o campo da tela do monitor é o Composer do chat: envia para a conversa do agente selecionada no 3D (mesmo envio do chat); só com a aba aberta', async () => {
    seed([conv('c1', 'Conversa'), conv('c2', 'Agente da mesa')], 'office')
    office.monitor = true
    render(<UiProvider><App /></UiProvider>)
    await screen.findByTestId('office-stub')
    // Clique no agente no 3D: o Escritório seleciona a conversa dele (model.convId).
    act(() => office.props?.onOpenConversation('c2'))
    await waitFor(() => expect(office.props?.conversation?.id).toBe('c2'))
    const ta = within(await screen.findByTestId('office-monitor-stub')).getByPlaceholderText(/Mensagem para o Claude/i) as HTMLTextAreaElement
    await waitFor(() => expect(ta.disabled).toBe(false))
    fireEvent.change(ta, { target: { value: 'oi, agente da mesa' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    await waitFor(() => expect(api.startAgent).toHaveBeenCalledTimes(1))
    expect(api.startAgent).toHaveBeenCalledWith(expect.objectContaining({ convId: 'c2' }))
    fireEvent.click(tab(/Conversa/))
    await waitFor(() => expect(office.props?.active).toBe(false))
    expect(office.props?.monitorComposer).toBeNull()
  })

  it('o "Ouvir" do Chat da tela do monitor é o TTS do chat: o App põe o mesmo em volta do Escritório (o mesmo áudio)', async () => {
    seed([conv('c1', 'Conversa')], 'office')
    render(<UiProvider><App /></UiProvider>)
    await screen.findByTestId('office-stub')
    expect(office.tts).toMatchObject({ speakingId: null })
    await act(async () => {
      void office.tts!.onToggleSpeak('m1', 'Olá, mundo.')
    })
    expect(api.speak).toHaveBeenCalledWith(expect.stringContaining('Olá, mundo'))
  })

  it('o seletor de modelo da tela do monitor troca o modelo da conversa do agente (não o da ativa); só com a aba aberta', async () => {
    seed([conv('c1', 'Conversa'), conv('c2', 'Agente da mesa')], 'office')
    office.pickerFor = 'c2'
    render(<UiProvider><App /></UiProvider>)
    const stub = await screen.findByTestId('office-picker-stub')
    const select = (await within(stub).findByRole('combobox', { name: 'Modelo' })) as HTMLSelectElement
    expect(select.value).toBe('claude-opus-4-8')
    const other = Array.from(select.options).find((o) => o.value !== 'claude-opus-4-8' && o.value !== 'auto')!
    fireEvent.change(select, { target: { value: other.value } })
    await waitFor(() => expect((within(screen.getByTestId('office-picker-stub')).getByRole('combobox', { name: 'Modelo' }) as HTMLSelectElement).value).toBe(other.value))
    // A conversa ativa (c1) não muda.
    expect(office.props?.conversation?.id).toBe('c1')
    const saved = (): Array<{ id: string; model: string }> => JSON.parse(localStorage.getItem('agentcode.conversations.v1') ?? '[]')
    await waitFor(() => expect(saved().find((c) => c.id === 'c2')?.model).toBe(other.value))
    expect(saved().find((c) => c.id === 'c1')?.model).toBe('claude-opus-4-8')
    fireEvent.click(tab(/Conversa/))
    await waitFor(() => expect(office.props?.active).toBe(false))
    expect(office.props?.monitorModelPicker).toBeUndefined()
  })

  it('clicar na Central da barra lateral avisa o Escritório (centralSignal), mesmo com ela já ativa', async () => {
    seed([conv('c1', 'Conversa')], 'office')
    render(<UiProvider><App /></UiProvider>)
    await screen.findByTestId('office-stub')
    const before = office.props?.centralSignal ?? 0
    const item = await screen.findByRole('button', { name: /Central.*fale com o agent/ })
    fireEvent.click(item)
    await waitFor(() => expect(office.props?.conversation?.id).toBe('central'))
    expect(office.props?.centralSignal).toBe(before + 1)
    fireEvent.click(screen.getByRole('button', { name: /Central.*fale com o agent/ }))
    await waitFor(() => expect(office.props?.centralSignal).toBe(before + 2))
  })

  it('o Escritório recebe o painel da Central (sem mesa selecionada) só com a aba aberta', async () => {
    seed([conv('c1', 'Conversa')], 'office')
    render(<UiProvider><App /></UiProvider>)
    await screen.findByTestId('office-stub')
    // O boot cria a Central ao fundo: a conversa ativa continua a c1.
    await waitFor(() => expect(isValidElement(office.props?.central)).toBe(true))
    const panel = office.props?.central as ReactElement<CentralPanelProps>
    expect(panel.type).toBe(CentralPanel)
    expect(panel.props.conversation.id).toBe('central')
    expect(office.props?.conversation?.id).toBe('c1')
    fireEvent.click(tab(/Conversa/))
    await waitFor(() => expect(office.props?.active).toBe(false))
    expect(office.props?.central).toBeNull()
  })

  it('a Central ainda não carregada (a leitura dela falhou): o Escritório recebe central null', async () => {
    const original = api.loadVersionedConversations.getMockImplementation() as (req?: { ids?: string[] }) => Promise<unknown>
    api.loadVersionedConversations.mockImplementation(async (req?: { ids?: string[] }) => {
      if (req?.ids) throw new Error('banco fora do ar')
      return original(req)
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seed([conv('c1', 'Conversa')], 'office')
    render(<UiProvider><App /></UiProvider>)
    await screen.findByTestId('office-stub')
    await waitFor(() => expect(warn.mock.calls.some(([m]) => String(m).includes('[central]'))).toBe(true))
    expect(office.props?.active).toBe(true)
    expect(office.props?.central).toBeNull()
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
