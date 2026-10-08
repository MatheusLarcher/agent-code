/**
 * Dublê dos testes da Central no App inteiro (não é teste): o window.api falso, as
 * conversas semeadas no "banco" (localStorage), os ouvintes que o App registra
 * (eventos do agente, celular, MCP, Stop e ações remotas) e o painel da Central
 * de mentira — que recebe o controller REAL pela fábrica `centralPanel(conv)`.
 *
 * Cada arquivo de teste registra o painel com
 * `vi.mock('./CentralPanel', async () => ({ CentralPanel: (await import('./centralAppKit')).MockCentralPanel }))`.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, vi } from 'vitest'
import type { AgentEventMsg, ChatEvent, PermissionRequest, PermissionResponse } from '@shared/ipc'
import type { CentralRequestEntry, CentralRouteRequest, CentralRouteResult } from '@shared/central'
import type { CentralController } from './useCentral'
import { syncIntoLocalStorage } from '../conversationSyncFake'

type Send = (t: string, i: [], th: [], f: [], r: []) => void

/** O painel da Central de mentira: campo do pedido, "não era aqui" e as opções do "Para onde vai?". */
export function MockCentralPanel(props: { controller?: CentralController; onSend: Send }): JSX.Element {
  return (
    <section aria-label="Central">
      <input aria-label="pedido" onKeyDown={(e) => e.key === 'Enter' && props.onSend((e.target as HTMLInputElement).value, [], [], [], [])} />
      {props.controller?.entries.map((e) =>
        e.kind === 'request' ? (
          <div key={e.id}>
            <button onClick={() => void props.controller?.notHere(e.id)}>{`não era aqui: ${e.text}`}</button>
            {e.state === 'asking' &&
              e.ask?.options.map((_, i) => (
                <button key={i} onClick={() => void props.controller?.choose(e.id, i)}>{`escolher ${i}: ${e.text}`}</button>
              ))}
          </div>
        ) : null
      )}
    </section>
  )
}

export type Stored = { id: string; cwd?: string; [k: string]: unknown }
export type StoredMessage = { kind: string; id: string; text: string; injected?: boolean; canceled?: boolean; error?: string }

export const KEY = 'agentcode.conversations.v1'
export const stored = (): Stored[] => JSON.parse(localStorage.getItem(KEY) || '[]')
export const storedConv = (id: string) => stored().find((c) => c.id === id) as { messages: StoredMessage[] } | undefined
export const centralRequests = (): CentralRequestEntry[] =>
  ((stored().find((c) => c.id === 'central') as { central?: { entries: CentralRequestEntry[] } } | undefined)?.central?.entries ?? []).filter(
    (e) => e.kind === 'request'
  )

/** Os ouvintes que o App registrou no window.api falso. */
export const cbs: {
  agent: ((m: AgentEventMsg) => void) | null
  inbound: ((m: { convId: string; text: string }) => void) | null
  mcp: ((m: { taskId: string; convId: string; text: string }) => void) | null
  remoteInterrupt: ((m: { convId: string }) => void) | null
  remoteAction: ((m: { type: string; convId: string; [k: string]: unknown }) => void) | null
  perm?: ((m: { convId: string; req: PermissionRequest }) => void) | null
  remotePerm?: ((m: { convId: string; res: PermissionResponse }) => void) | null
  remoteChoose?: ((m: { entryId: string; option: number }) => void) | null
} = { agent: null, inbound: null, mcp: null, remoteInterrupt: null, remoteAction: null }

export const C1 = { kind: 'conversation' as const, convId: 'c1', cwd: '/proj', project: 'proj', title: 'Conversa', sandbox: false }

export function installApi(route: (req: CentralRouteRequest) => CentralRouteResult) {
  cbs.agent = cbs.inbound = cbs.mcp = cbs.remoteInterrupt = cbs.remoteAction = null
  cbs.perm = cbs.remotePerm = cbs.remoteChoose = null
  const versioned = (payload: Stored) => ({ id: payload.id, payload, revision: 1, contentHash: JSON.stringify(payload), createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() })
  const remote = { running: false, url: '', ip: '', port: 0, token: '', clients: 0, relayConnected: false }
  const fn = <T,>(v: T) => vi.fn(async (..._args: unknown[]) => v)
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
    syncConversations: vi.fn(syncIntoLocalStorage(KEY)),
    flushConversations: fn(true),
    getConversationSaveStatus: fn({ state: 'saved', pending: 0, oldestMs: 0 }),
    onConversationSaveStatus: off(), onConversationResync: off(), onCentralRemote: off(),
    onWindowsControlChanged: off(), setWindowsControlEnabled: fn(undefined), setChromeControlEnabled: fn(undefined), onChromeControlChanged: off(),
    getChromeBridgeStatus: fn({ listening: false, port: null, connected: false, extensionVersion: null, userAgent: null }), onChromeBridgeStatusChanged: off(),
    authStatus: fn({ authenticated: true }), codexStatus: fn({ connected: false }),
    sandboxInfo: fn({ root: 'C:\\local\\sandbox' }), sandboxCreate: fn({ path: 'C:\\local\\sandbox\\x' }),
    providersStatus: fn({ claude: true, gpt: false, ollama: false }), onProvidersChanged: off(),
    pathExists: fn(true), projectTree: fn({ nodes: [], truncated: false, missing: [] }),
    kvGet: vi.fn(async (key: string) => localStorage.getItem(key)), kvSet: vi.fn(async (key: string, value: string) => localStorage.setItem(key, value)),
    getCacheInfo: fn({ dir: '', dbPath: '', memoriesDir: '', skillsDir: '' }), getAppVersion: fn('test'),
    startAgent: fn<unknown>({ ok: true }), sendMessage: fn<unknown>(undefined), interrupt: fn<unknown>({ stillQueued: [] }), injectNow: fn({ ok: true }),
    disposeAgent: fn(undefined), refreshUsage: fn(undefined), getTokenUsageHistory: fn({ calls: [], totals: [] }),
    getTurnTimeTotals: fn({ totalMs: 0, turns: 0, lastMs: null }),
    listContextTurns: fn([]), readContextTurn: fn(null), countContextExact: fn({ ok: false, usage: null }),
    revealSecret: fn(null), onContextTurnsChanged: off(),
    onAgentEvent: vi.fn((cb: (m: AgentEventMsg) => void) => ((cbs.agent = cb), () => {})),
    onPermissionRequest: vi.fn((cb: (m: { convId: string; req: PermissionRequest }) => void) => ((cbs.perm = cb), () => {})),
    onPermissionExpired: off(), onVigiaAlert: off(), onBoardChanged: off(),
    boardList: fn({ available: true, items: [] }), tasksBoard: fn({ available: false, items: [] }), boardDismiss: fn(null),
    respondPermission: fn(undefined), onPoProviderDiagnostic: off(), setActiveBrowser: fn(undefined), disposeBrowser: fn(undefined),
    newTab: fn(undefined), closeTab: fn(undefined), onBrowserFrame: off(), onBrowserState: off(), onBrowserPicked: off(), onAndroidProgress: off(),
    remoteStatus: fn(remote), publishRemoteState: fn(undefined),
    onRemoteInbound: vi.fn((cb: (m: { convId: string; text: string }) => void) => ((cbs.inbound = cb), () => {})),
    onMcpInbound: vi.fn((cb: (m: { taskId: string; convId: string; text: string }) => void) => ((cbs.mcp = cb), () => {})),
    mcpRendererReady: fn(undefined), mcpTaskFailed: fn(undefined),
    onRemoteSetSkipPerms: off(), onRemoteSetModel: off(), onRemoteRecoveryAction: off(),
    onRemotePermissionResponse: vi.fn((cb: (m: { convId: string; res: PermissionResponse }) => void) => ((cbs.remotePerm = cb), () => {})),
    onRemoteCentralChoose: vi.fn((cb: (m: { entryId: string; option: number }) => void) => ((cbs.remoteChoose = cb), () => {})),
    onRemoteInterrupt: vi.fn((cb: (m: { convId: string }) => void) => ((cbs.remoteInterrupt = cb), () => {})),
    onRemoteSetMode: off(),
    onRemoteConversationAction: vi.fn((cb: (m: { type: string; convId: string }) => void) => ((cbs.remoteAction = cb), () => {})),
    onRemoteClients: off(),
    centralRoute: vi.fn(async (req: CentralRouteRequest) => route(req)), centralCorrection: fn(undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

export type FakeApi = ReturnType<typeof installApi>

export const conv = (id: string, title: string, cwd: string, extra: Record<string, unknown> = {}): Stored => ({
  id, title, cwd, model: 'claude-opus-4-8', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: 1, updatedAt: 2, ...extra
})

/** Direto para c1; o reenvio forçado ("não era aqui", descarte) pergunta com um sandbox novo. */
export const toC1 = (req: CentralRouteRequest): CentralRouteResult =>
  req.forceAsk ? { kind: 'ask', options: [{ target: { kind: 'new-sandbox' } }], reason: 'moved' } : { kind: 'direct', target: C1, rule: 'continua', confidence: 0.9, why: 'continua “Conversa”' }

/** O "banco" com c1 (aberta) e um planejamento; a Central nasce no boot. */
export function seedStorage(): void {
  localStorage.clear()
  localStorage.setItem(KEY, JSON.stringify([conv('c1', 'Conversa', '/proj'), conv('p1', 'Plano', '/proj', { mode: 'planning', planningSlug: 'plano-x' })]))
  localStorage.setItem('agentcode.ui.v1', JSON.stringify({ collapsed: false, activeId: 'c1', browserMinimized: true }))
}

export async function emit(event: ChatEvent, convId = 'c1'): Promise<void> {
  await act(async () => cbs.agent?.({ convId, event }))
}
export const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: 'ok', durationMs: 1 }
export const streamEnd: ChatEvent = { kind: 'error', id: 'fim', text: 'Agent stopped: aborted' }

export async function typeInConversation(text: string): Promise<void> {
  const box = (await screen.findByPlaceholderText(/Mensagem para o Claude/i)) as HTMLTextAreaElement
  await waitFor(() => expect(box.disabled).toBe(false))
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

export async function openCentral(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /Central.*fale com o agent/ }))
}

export async function sendInCentral(text: string): Promise<void> {
  await openCentral()
  const box = await screen.findByRole('textbox', { name: 'pedido' })
  fireEvent.change(box, { target: { value: text } })
  fireEvent.keyDown(box, { key: 'Enter' })
}

/** Abre a conversa pela linha dela na barra lateral. */
export async function openConversation(title: string): Promise<void> {
  const rows = await screen.findAllByTitle(new RegExp(`^${title} — duplo-clique para renomear$`))
  fireEvent.click(rows[0])
}

/** O que foi ao agente: [conversa, texto] de cada `sendMessage`. */
export const sends = (api: FakeApi): Array<[string, string]> => api.sendMessage.mock.calls.map((c: unknown[]) => [c[0] as string, c[1] as string])
export const sentTexts = (api: FakeApi): string[] => sends(api).map(([, text]) => text)
