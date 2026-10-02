/**
 * A Central no App inteiro: boot (cria ou carrega por id), lugar fixo na barra
 * lateral, gate do TypeSafe, painel e envio. O window.api é o dublê do
 * App.test.tsx, com a carga inicial POR PROJETO de verdade (`cwds`): conversa
 * sem pasta, como a Central, fica de fora dela e só chega pela leitura por id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'

configure({ asyncUtilTimeout: 10_000 })

window.HTMLElement.prototype.scrollIntoView = vi.fn()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

type Stored = { id: string; cwd?: string; [k: string]: unknown }
type Inbound = (m: { convId: string; text: string; images?: unknown[]; files?: unknown[] }) => void

const KEY = 'agentcode.conversations.v1'
const GATE = 'Ative o TypeSafe e informe a API key nas Configurações para usar a Central.'
const stored = (): Stored[] => JSON.parse(localStorage.getItem(KEY) || '[]')
const storedCentral = (): Stored | undefined => stored().find((c) => c.id === 'central')
let inboundCb: Inbound | null = null

function installApi(): Record<string, ReturnType<typeof vi.fn>> {
  inboundCb = null
  const versioned = (payload: Stored) => ({
    id: payload.id,
    payload,
    revision: 1,
    contentHash: JSON.stringify(payload),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  })
  const remote = { running: false, url: '', ip: '', port: 0, token: '', clients: 0, relayConnected: false }
  const api = {
    getConfig: vi.fn(async () => ({ voice: { voice: 'pf_dora', speed: 1 }, ollama: { enabled: false, apiKey: '' }, skipPermissions: false, windowsControlEnabled: false, remoteToken: '', remoteEnabled: false })),
    setConfig: vi.fn(async () => {}),
    isTypeSafeConfigured: vi.fn(async () => true),
    onAppCloseRequested: vi.fn(() => () => {}),
    appCloseReady: vi.fn(async () => {}),
    onAppReloadRequested: vi.fn(() => () => {}),
    appReloadReady: vi.fn(async () => {}),
    getStorageStatus: vi.fn(async () => ({ backend: 'sqlite', state: 'sqlite-ready', writable: true, installationId: '00000000-0000-4000-8000-000000000001', targetDatabase: 'agent-code', hasPassword: false })),
    onStorageStatusChanged: vi.fn(() => () => {}),
    onStorageFlushRequested: vi.fn(() => () => {}),
    storageFlushReady: vi.fn(async () => {}),
    onStorageChanged: vi.fn(() => () => {}),
    // Como o banco: um resumo por pasta, inclusive a vazia (o renderer a descarta).
    countConversationsByProject: vi.fn(async () => {
      const by = new Map<string, number>()
      for (const c of stored()) by.set(c.cwd ?? '', (by.get(c.cwd ?? '') ?? 0) + 1)
      return [...by].map(([cwd, total]) => ({ cwd, total, updatedAt: new Date(0).toISOString() }))
    }),
    loadVersionedConversations: vi.fn(async (q?: { ids?: string[]; cwds?: string[] }) =>
      stored().filter((c) => (!q?.ids || q.ids.includes(c.id)) && (!q?.cwds || q.cwds.includes(c.cwd ?? ''))).map(versioned)
    ),
    upsertConversation: vi.fn(async (input: { id: string; payload: Stored; expectedRevision?: number }) => {
      localStorage.setItem(KEY, JSON.stringify([...stored().filter((c) => c.id !== input.id), input.payload]))
      return { ...versioned(input.payload), revision: (input.expectedRevision ?? 0) + 1 }
    }),
    deleteConversation: vi.fn(async (input: { id: string; expectedRevision: number }) => {
      const payload = stored().find((c) => c.id === input.id) ?? { id: input.id }
      localStorage.setItem(KEY, JSON.stringify(stored().filter((c) => c.id !== input.id)))
      return { ...versioned(payload), revision: input.expectedRevision + 1, deletedAt: new Date().toISOString() }
    }),
    onWindowsControlChanged: vi.fn(() => () => {}),
    // O que as Configurações leem ao abrir (o gate do TypeSafe as abre).
    getPostgresSettings: vi.fn(async () => ({ host: 'localhost', port: 5432, user: 'postgres', maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '' })),
    testPostgresConnection: vi.fn(async () => {}),
    activatePostgres: vi.fn(async () => {}),
    deactivatePostgres: vi.fn(async () => {}),
    retryStorage: vi.fn(async () => {}),
    clearPostgresPassword: vi.fn(async () => {}),
    setWindowsControlEnabled: vi.fn(async () => {}),
    setChromeControlEnabled: vi.fn(async () => {}),
    onChromeControlChanged: vi.fn(() => () => {}),
    getChromeBridgeStatus: vi.fn(async () => ({ listening: false, port: null, connected: false, extensionVersion: null, userAgent: null })),
    onChromeBridgeStatusChanged: vi.fn(() => () => {}),
    installChromeExtension: vi.fn(async () => ''),
    chooseCacheDir: vi.fn(async () => null),
    authStatus: vi.fn(async () => ({ authenticated: true })),
    authLogin: vi.fn(async () => ({ ok: true })),
    codexStatus: vi.fn(async () => ({ connected: false })),
    codexLogin: vi.fn(async () => ({ ok: true })),
    codexLogout: vi.fn(async () => undefined),
    sandboxInfo: vi.fn(async () => ({ root: 'C:\\local\\sandbox' })),
    sandboxCreate: vi.fn(async () => ({ path: 'C:\\local\\sandbox\\2026-10-02_10-00_abcd' })),
    providersStatus: vi.fn(async () => ({ claude: true, gpt: false, ollama: false })),
    onProvidersChanged: vi.fn(() => () => {}),
    pathExists: vi.fn(async () => true),
    projectTree: vi.fn(async () => ({ nodes: [], truncated: false, missing: [] })),
    kvGet: vi.fn(async (key: string) => localStorage.getItem(key)),
    kvSet: vi.fn(async (key: string, value: string) => localStorage.setItem(key, value)),
    getCacheInfo: vi.fn(async () => ({ dir: '', dbPath: '', memoriesDir: '', skillsDir: '' })),
    getAppVersion: vi.fn(async () => 'test'),
    startAgent: vi.fn(() => new Promise<{ ok: boolean }>(() => {})),
    sendMessage: vi.fn(async () => {}),
    interrupt: vi.fn(async () => ({ stillQueued: [] })),
    disposeAgent: vi.fn(async () => {}),
    refreshUsage: vi.fn(async () => {}),
    getTokenUsageHistory: vi.fn(async () => ({ calls: [], totals: [] })),
    onAgentEvent: vi.fn(() => () => {}),
    onPermissionRequest: vi.fn(() => () => {}),
    onPermissionExpired: vi.fn(() => () => {}),
    onVigiaAlert: vi.fn(() => () => {}),
    onBoardChanged: vi.fn(() => () => {}),
    boardList: vi.fn(async () => ({ available: true, items: [] })),
    tasksBoard: vi.fn(async () => ({ available: false, items: [] })),
    boardDismiss: vi.fn(async () => null),
    respondPermission: vi.fn(async () => {}),
    onPoProviderDiagnostic: vi.fn(() => () => {}),
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
    onRemoteInbound: vi.fn((cb: Inbound) => {
      inboundCb = cb
      return () => {
        if (inboundCb === cb) inboundCb = null
      }
    }),
    onRemoteSetSkipPerms: vi.fn(() => () => {}),
    onRemoteSetModel: vi.fn(() => () => {}),
    onRemoteRecoveryAction: vi.fn(() => () => {}),
    onRemotePermissionResponse: vi.fn(() => () => {}),
    onRemoteInterrupt: vi.fn(() => () => {}),
    onRemoteSetMode: vi.fn(() => () => {}),
    onRemoteConversationAction: vi.fn(() => () => {}),
    onRemoteClients: vi.fn(() => () => {}),
    remoteStart: vi.fn(async () => remote),
    remoteStop: vi.fn(async () => remote),
    remoteUnpair: vi.fn(async () => remote),
    buildRemoteApk: vi.fn(async () => ({ ok: true, message: '' })),
    onRemoteBuildProgress: vi.fn(() => () => {})
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

const conv = (id: string, title: string, cwd: string, extra: Record<string, unknown> = {}): Stored => ({
  id,
  title,
  cwd,
  model: 'claude-opus-4-8',
  sdkSessionId: null,
  messages: [],
  tokens: { context: 0, output: 0, cost: 0 },
  createdAt: 1,
  updatedAt: 2,
  ...extra
})
const centralConv = (entries: unknown[] = []): Stored =>
  conv('central', 'Central', '', { titleSource: 'user', mode: 'central', central: { entries } })
const request = (id: string, text: string, attachments?: string[]) => ({ kind: 'request', id, ts: 5, text, state: 'routing', ...(attachments ? { attachments } : {}) })

function seed(list: Stored[], ui: { activeId?: string; collapsed?: boolean } = {}): void {
  localStorage.setItem(KEY, JSON.stringify(list))
  localStorage.setItem('agentcode.ui.v1', JSON.stringify({ collapsed: ui.collapsed ?? false, activeId: ui.activeId ?? 'c1', browserMinimized: true }))
}

const mount = () => render(<UiProvider><App /></UiProvider>)
const centralItem = (): Promise<HTMLElement> => screen.findByRole('button', { name: /Central.*fale com o agent/ })
const panel = (): Promise<HTMLElement> => screen.findByRole('region', { name: 'Central' })

async function typeAndEnter(box: HTMLElement, text: string): Promise<void> {
  await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false))
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  localStorage.clear()
  seed([conv('c1', 'Conversa', '/proj')])
  api = installApi()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Central — boot', () => {
  it('sem Central no banco: procura por id e cria UMA (id central, mode central, cwd vazio), sem abrir nela', async () => {
    mount()
    await waitFor(() => expect(storedCentral()).toMatchObject({ id: 'central', mode: 'central', cwd: '', title: 'Central', titleSource: 'user', central: { entries: [] } }))
    expect(api.loadVersionedConversations).toHaveBeenCalledWith({ ids: ['central'] })
    expect(stored().filter((c) => c.id === 'central')).toHaveLength(1)
    // A conversa aberta continua a de antes.
    expect((await centralItem()).getAttribute('aria-current')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Central' })).toBeNull()
  })

  it('com a Central no banco (fora da carga por projeto): carrega por id e não recria', async () => {
    seed([conv('c1', 'Conversa', '/proj'), centralConv([request('r1', 'quanto tá o dólar?')])])
    mount()
    await waitFor(() => expect(api.loadVersionedConversations).toHaveBeenCalledWith({ ids: ['central'] }))
    fireEvent.click(await centralItem())
    expect(await within(await panel()).findByText('quanto tá o dólar?')).toBeTruthy()
    expect(storedCentral()).toMatchObject({ central: { entries: [{ id: 'r1' }] } })
  })

  it('aberta na sessão anterior: o boot abre direto nela', async () => {
    seed([conv('c1', 'Conversa', '/proj'), centralConv()], { activeId: 'central' })
    mount()
    expect(await panel()).toBeTruthy()
    expect((await centralItem()).getAttribute('aria-current')).toBe('page')
  })
})

describe('Central — barra lateral', () => {
  it('fixa acima do grupo Sandbox; fora dos projetos, de Chats e da busca', async () => {
    seed(
      [
        conv('c1', 'Conversa', '/proj'),
        conv('c2', 'Ajuste da central de ajuda', '/proj'),
        conv('s1', 'Cotação do dólar', 'C:\\local\\sandbox\\2026-09-29_10-00_abcd'),
        centralConv([request('r1', 'quanto tá o dólar?')])
      ],
      { activeId: 'central' }
    )
    const { container } = mount()
    // Só confere com a Central JÁ carregada (o painel dela, com o pedido gravado):
    // antes disso a barra passaria sem filtro nenhum.
    expect(await within(await panel()).findByText('quanto tá o dólar?')).toBeTruthy()
    const item = await centralItem()
    const sandbox = await screen.findByText('Sandbox')
    expect(item.compareDocumentPosition(sandbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await screen.findAllByText('Cotação do dólar')
    const titles = (): string[] => [...container.querySelectorAll('.conv-title')].map((el) => el.textContent ?? '')
    expect(titles()).not.toContain('Central')
    expect([...container.querySelectorAll('.project-name')].map((el) => el.textContent)).toEqual(['Sandbox', 'proj'])
    // A busca acha a conversa que fala de "central" — a Central, nunca.
    fireEvent.change(screen.getByPlaceholderText(/Buscar conversas/), { target: { value: 'central' } })
    expect(titles()).toContain('Ajuste da central de ajuda')
    expect(titles()).not.toContain('Central')
  })

  it('barra recolhida: o orbe é o primeiro item do trilho', async () => {
    seed([conv('c1', 'Conversa', '/proj')], { collapsed: true })
    mount()
    const orb = await screen.findByRole('button', { name: 'Central' })
    const novo = document.querySelector('.sidebar.collapsed .rail-btn.accent')
    expect(novo).not.toBeNull()
    expect(orb.compareDocumentPosition(novo!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('.sidebar.collapsed .rail-btn')).toBe(orb)
  })
})

describe('Central — gate do TypeSafe e painel', () => {
  it('sem TypeSafe: o clique seleciona a Central E abre as Configurações no TypeSafe com o aviso dela', async () => {
    api.isTypeSafeConfigured.mockResolvedValue(false)
    mount()
    await waitFor(() => expect(api.isTypeSafeConfigured).toHaveBeenCalled())
    fireEvent.click(await centralItem())
    expect(await screen.findByText(GATE)).toBeTruthy()
    await waitFor(() => expect(document.querySelector('.settings-highlight')).not.toBeNull())
    expect((await centralItem()).getAttribute('aria-current')).toBe('page')
  })

  it('com TypeSafe: o painel da Central entra no lugar do chat (cabeçalho, campo e dica)', async () => {
    mount()
    fireEvent.click(await centralItem())
    const p = await panel()
    expect(within(p).getByRole('heading', { name: 'Central' })).toBeTruthy()
    expect(within(p).getByRole('textbox', { name: 'Mensagem' }).getAttribute('aria-placeholder')).toBe('Fale com o agent…')
    expect(within(p).getByText('o destino é escolhido pelo assunto')).toBeTruthy()
    expect(screen.queryByText(GATE)).toBeNull()
    // Nada do chat de agente: sem cabeçalho de consumo nem seletor de modelo.
    expect(document.querySelector('.chat-header')).toBeNull()
    expect(document.querySelector('.token-meter')).toBeNull()
  })

  it('enviar registra o pedido (deste PC), vai ao roteador e NÃO sobe sessão de agente', async () => {
    mount()
    fireEvent.click(await centralItem())
    const p = await panel()
    await typeAndEnter(within(p).getByRole('textbox', { name: 'Mensagem' }), 'o botão ficou torto')
    expect(await within(p).findByText('o botão ficou torto')).toBeTruthy()
    // Este dublê não tem o IPC central:route: a Central pergunta com a heurística (nada se perde).
    await waitFor(() =>
      expect(storedCentral()).toMatchObject({
        central: {
          entries: [
            {
              kind: 'request',
              state: 'asking',
              origin: 'central',
              device: '00000000-0000-4000-8000-000000000001',
              text: 'o botão ficou torto',
              ask: { reason: 'typesafe-failed', options: [{ target: { kind: 'new-sandbox' } }] }
            }
          ]
        }
      })
    )
    expect(api.startAgent).not.toHaveBeenCalled()
    expect(api.sendMessage).not.toHaveBeenCalled()
  })

  it('sem TypeSafe, enviar roda o gate, não registra nada e o texto continua no campo', async () => {
    api.isTypeSafeConfigured.mockResolvedValue(false)
    seed([conv('c1', 'Conversa', '/proj'), centralConv()], { activeId: 'central' })
    mount()
    await waitFor(() => expect(api.isTypeSafeConfigured).toHaveBeenCalled())
    const box = within(await panel()).getByRole('textbox', { name: 'Mensagem' })
    await typeAndEnter(box, 'deixa mais escuro')
    expect(await screen.findByText(GATE)).toBeTruthy()
    expect((box as HTMLTextAreaElement).value).toBe('deixa mais escuro')
    await act(async () => new Promise((r) => setTimeout(r, 500)))
    expect(storedCentral()).toMatchObject({ central: { entries: [] } })
    expect(api.startAgent).not.toHaveBeenCalled()
  })

  it('sem TypeSafe, o botão de enviar passa pelo mesmo gate; e não há escudo de revisão para escapar dele', async () => {
    api.isTypeSafeConfigured.mockResolvedValue(false)
    seed([conv('c1', 'Conversa', '/proj'), centralConv()], { activeId: 'central' })
    mount()
    await waitFor(() => expect(api.isTypeSafeConfigured).toHaveBeenCalled())
    const p = await panel()
    expect(within(p).queryByTitle(/Revisar código/)).toBeNull()
    const box = within(p).getByRole('textbox', { name: 'Mensagem' })
    await waitFor(() => expect((box as HTMLTextAreaElement).disabled).toBe(false))
    fireEvent.change(box, { target: { value: 'o botão ficou torto' } })
    fireEvent.click(within(p).getByTitle('Enviar'))
    expect(await screen.findByText(GATE)).toBeTruthy()
    await waitFor(() => expect(document.querySelector('.settings-highlight')).not.toBeNull())
    expect((box as HTMLTextAreaElement).value).toBe('o botão ficou torto')
    await act(async () => new Promise((r) => setTimeout(r, 500)))
    expect(storedCentral()).toMatchObject({ central: { entries: [] } })
    expect(api.startAgent).not.toHaveBeenCalled()
  })
})

describe('Central — celular', () => {
  it('mensagem do celular para a Central vira pedido (só nomes de anexo) e é roteada, sem dispatch', async () => {
    mount()
    await waitFor(() => expect(storedCentral()).toBeTruthy())
    await waitFor(() => expect(inboundCb).not.toBeNull())
    await act(async () => {
      inboundCb?.({ convId: 'central', text: 'quanto tá o dólar?', images: [{ mediaType: 'image/png', data: 'QUJDRA==' }] })
    })
    await waitFor(() =>
      expect(storedCentral()).toMatchObject({
        central: { entries: [{ kind: 'request', state: 'asking', text: 'quanto tá o dólar?', attachments: ['imagem'] }] }
      })
    )
    // Os bytes ficam em memória, nunca no payload da Central.
    expect(JSON.stringify(storedCentral())).not.toContain('QUJDRA==')
    expect(api.startAgent).not.toHaveBeenCalled()
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(screen.queryByText(/conversa inexistente/)).toBeNull()
  })
})
