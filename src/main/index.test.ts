import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// index.ts é o entrypoint do processo main: registra centenas de handlers de
// IPC e, no topo do módulo, referencia `app`/`BrowserWindow`/etc de forma
// síncrona. Fora do runtime do Electron, `import 'electron'` não devolve o
// objeto real — por isso cada dependência transitiva pesada é mockada aqui,
// só o suficiente para `registerIpc()` (exportado só para este teste) rodar
// sem passar pelo `app.whenReady()` que dispara o boot inteiro do app.

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

// Espiões da ligação do planejamento: os quatro observadores e as sessões que o
// agent:start cria (com o `emit` do tee que ele entregou a cada uma).
type CreatedSession = {
  opts: { convId: string; model?: string; effort?: string }
  emit: (event: unknown) => void
  send: ReturnType<typeof vi.fn>
}
const spy = vi.hoisted(() => ({
  observe: { vigia: vi.fn(), board: vi.fn(), po: vi.fn(), memorista: vi.fn() },
  note: { vigia: vi.fn(), po: vi.fn(), memorista: vi.fn() },
  sessions: [] as CreatedSession[],
  planningConfig: { model: 'claude-opus-5-5', effort: 'high' }
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app',
    getPath: () => '/app-data',
    getVersion: () => '0.0.0',
    quit: vi.fn(),
    whenReady: () => new Promise(() => {}),
    on: vi.fn(),
    requestSingleInstanceLock: () => true
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return []
    }
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  dialog: {},
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: {},
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {}
}))

vi.mock('./browserController', () => ({ BrowserController: class {} }))
vi.mock('./agentSession', () => ({ AgentSession: class {} }))
vi.mock('./providerFailover', () => ({
  ProviderFailoverSession: class {
    send = vi.fn(async () => undefined)
    constructor(opts: CreatedSession['opts'], _factory: unknown, emit: (event: unknown) => void) {
      spy.sessions.push({ opts, emit, send: this.send })
    }
    async start(): Promise<boolean> {
      return true
    }
    dispose(): void {}
  }
}))
vi.mock('./appRestart', () => ({ AppRestartCoordinator: class {} }))
vi.mock('./appRestartRuntime', () => ({ configureAppRestart: vi.fn(), appRestart: null }))
vi.mock('./appRelauncher', () => ({ armAppRelauncher: vi.fn() }))
vi.mock('./remote/remoteServer', () => ({ RemoteServer: class { broadcast(): void {} } }))
vi.mock('./remote/relayClient', () => ({ RelayClient: class {} }))
vi.mock('./remote/remotePairing', () => ({ RemotePairingStore: class {} }))
vi.mock('./remote/buildApk', () => ({ buildRemoteApk: vi.fn() }))
vi.mock('./config', () => ({
  ensureConfigLoaded: vi.fn(),
  initializeConfigPersistence: vi.fn(),
  loadConfig: () => ({ planning: spy.planningConfig }),
  updateConfig: vi.fn()
}))
vi.mock('./openai', () => ({
  transcribeAudio: vi.fn(),
  synthesizeSpeech: vi.fn(),
  writeTempAudioSegment: vi.fn(),
  deleteTempAudioSegment: vi.fn()
}))
vi.mock('./speech', () => ({ stopLocalSpeech: vi.fn(), transcribeLocal: vi.fn() }))
vi.mock('./auth', () => ({ isAuthenticated: vi.fn(), logoutClaude: vi.fn() }))
vi.mock('./login', () => ({ runClaudeLogin: vi.fn() }))
vi.mock('./codexAuth', () => ({
  codexStatus: vi.fn(),
  codexLogout: vi.fn(),
  initializeCodexAuthPersistence: vi.fn(),
  runCodexLogin: vi.fn(),
  isCodexConnected: vi.fn()
}))
vi.mock('./codexProxy', () => ({ onCodexRateLimit: vi.fn() }))
vi.mock('./store', () => ({ initStore: vi.fn(), getCacheInfo: vi.fn(), setCacheDir: vi.fn() }))

const listLlmCalls = vi.fn()
const listLlmUsageTotals = vi.fn()
vi.mock('./persistence/lifecycle', () => ({
  storageLifecycle: {
    repository: () => ({
      listLlmCalls,
      listLlmUsageTotals,
      acquireConversationLease: async () => ({}),
      createSessionStore: () => ({})
    }),
    canMutate: () => true,
    status: vi.fn(() => ({ state: 'sqlite' })),
    subscribe: vi.fn(),
    subscribeChanges: vi.fn()
  }
}))
vi.mock('./persistence/leaseKeeper', () => ({
  ConversationLeaseKeeper: class {
    start(): this {
      return this
    }
    async release(): Promise<void> {}
  }
}))
vi.mock('./downloadAllowlist', () => ({
  DownloadAllowlist: class {
    track(): void {}
  },
  downloadablesFromMessages: vi.fn()
}))
vi.mock('./vigia/vigia', () => ({
  Vigia: class {
    observe = spy.observe.vigia
    noteUserMessage = spy.note.vigia
    dispose(): void {}
  }
}))
vi.mock('./board/boardService', () => ({
  BoardService: class {
    observe = spy.observe.board
    dispose(): void {}
  }
}))
vi.mock('./po/po', () => ({
  Po: class {
    observe = spy.observe.po
    noteUserMessage = spy.note.po
    dispose(): void {}
  }
}))
vi.mock('./memoria/memorista', () => ({
  Memorista: class {
    observe = spy.observe.memorista
    noteUserMessage = spy.note.memorista
    dispose(): void {}
  }
}))
vi.mock('./memoria/memoriasUsadas', () => ({ forgetUsedMemories: vi.fn(), usedMemories: new Set() }))
vi.mock('./persistence/kvFacade', () => ({
  configureKvRepositoryOffline: vi.fn(),
  readPersistedKv: vi.fn(),
  writePersistedKv: vi.fn()
}))
vi.mock('./persistence/hashes', () => ({ hashJson: vi.fn(), normalizeJson: vi.fn() }))
vi.mock('./persistence/projectIdentity', () => ({
  attachProjectIdentity: vi.fn(),
  isMissingProjectFolderError: vi.fn(),
  preserveProjectIdentityForMissingPersistedWrite: vi.fn()
}))
vi.mock('./conversationParquet', () => ({ dailyParquetPath: vi.fn(), exportConversationsParquet: vi.fn() }))
vi.mock('./persistence/conversationWriteRecovery', () => ({
  storageErrorForIpc: vi.fn(),
  upsertConversationWithLeaseRecovery: vi.fn()
}))
vi.mock('./attachments', () => ({
  saveAttachments: vi.fn(),
  resolvePastedPath: vi.fn(),
  downloadPastedUrl: vi.fn(),
  buildAttachmentNote: vi.fn()
}))
vi.mock('./memoryCurator', () => ({ startMemoryCuratorScheduler: vi.fn() }))
vi.mock('./tasks/taskRuntime', () => ({ taskLedger: vi.fn() }))
vi.mock('./tasks/taskBoard', () => ({ buildTaskBoard: vi.fn(), buildTaskDetail: vi.fn() }))
vi.mock('./tasks/taskReaper', () => ({ startTaskReaper: vi.fn() }))
vi.mock('./memory/memoryRuntime', () => ({
  configureSecretVault: vi.fn(),
  deleteSecret: vi.fn(),
  listSecretMetadata: vi.fn(),
  memoryService: {},
  restoreVault: vi.fn(),
  secretSink: vi.fn()
}))
vi.mock('./restartGuardFile', () => ({ startRestartGuardFile: vi.fn() }))
vi.mock('./sleepGuard', () => ({ startSleepGuard: vi.fn() }))
vi.mock('./windowsControl/service', () => ({ windowsControl: {} }))
vi.mock('./skillDiscovery', () => ({ discoverSkills: vi.fn() }))
vi.mock('./projectIcon', () => ({ readProjectIcon: vi.fn() }))
vi.mock('./skillManager', () => ({ syncCacheSkills: vi.fn() }))
vi.mock('./typesafe', () => ({ resolveAutoStart: vi.fn() }))
vi.mock('./typesafe/client', () => ({ typeSafeConfigured: vi.fn() }))

const { AUTO_MODEL, Channels } = await import('../shared/ipc')
const { registerIpc } = await import('./index')
const { resolveAutoStart } = await import('./typesafe')

describe('registerIpc — agent:token-usage:history', () => {
  it('devolve as chamadas e os totais do repositório ativo para o convId pedido', async () => {
    const calls = [{ id: 'c1', convId: 'conv-1' }]
    const totals = [{ convId: 'conv-1', day: '2026-09-19' }]
    listLlmCalls.mockResolvedValueOnce(calls)
    listLlmUsageTotals.mockResolvedValueOnce(totals)

    registerIpc()
    const handler = handlers.get(Channels.tokenUsageHistory)
    expect(handler).toBeTypeOf('function')

    const result = await handler!(null, 'conv-1')

    expect(listLlmCalls).toHaveBeenCalledWith('conv-1')
    expect(listLlmUsageTotals).toHaveBeenCalledWith('conv-1')
    expect(result).toEqual({ calls, totals })
  })
})

describe('registerIpc — conversation:suggestTitle', () => {
  it('registra o canal; payload inválido volta { ok: false } sem chamar o modelo', async () => {
    registerIpc()
    const handler = handlers.get(Channels.conversationSuggestTitle)
    expect(handler).toBeTypeOf('function')
    for (const bad of [undefined, { text: 1 }, { text: '   ' }, { text: 'x', extra: 1 }]) {
      await expect(Promise.resolve(handler!(null, bad))).resolves.toEqual({ ok: false })
    }
  })
})

describe('registerIpc — conversa do Agent Manager (opts.planning)', () => {
  const cwd = tmpdir()
  const event = { kind: 'result', id: 'r1', isError: false, text: 'ok', durationMs: 1 }
  const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(handlers.get(channel)!(null, ...args))
  const sessionOf = (convId: string): CreatedSession => spy.sessions.filter((s) => s.opts.convId === convId).at(-1)!
  const observers = (): ReturnType<typeof vi.fn>[] => [...Object.values(spy.observe), ...Object.values(spy.note)]

  beforeAll(() => registerIpc())

  it('agent:start resolve modelo/esforço pelo planejamento e NÃO passa pelo Automático da conversa', async () => {
    vi.mocked(resolveAutoStart).mockClear()
    spy.planningConfig = { model: 'claude-opus-5-5', effort: 'high' }
    const result = await call(Channels.agentStart, { convId: 'plan-1', cwd, model: AUTO_MODEL, planning: { slug: 'checkout' } })
    expect(result).toEqual({ ok: true })
    expect(resolveAutoStart).not.toHaveBeenCalled()
    expect(sessionOf('plan-1').opts).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', planning: { slug: 'checkout' } })
  })

  it('a conversa do Manager não alimenta vigia, quadro, PO nem memorista', async () => {
    for (const fn of observers()) fn.mockClear()
    await call(Channels.agentStart, { convId: 'plan-2', cwd, model: 'claude-sonnet-5', planning: { slug: 'checkout' } })
    const session = sessionOf('plan-2')
    session.emit(event)
    await call(Channels.agentSend, 'plan-2', 'separa as etapas')
    for (const fn of observers()) expect(fn).not.toHaveBeenCalled()
    // A mensagem segue para a sessão normalmente.
    expect(session.send).toHaveBeenCalled()
  })

  it('regressão: conversa comum alimenta os quatro no tee e os três no agent:send', async () => {
    for (const fn of observers()) fn.mockClear()
    await call(Channels.agentStart, { convId: 'comum', cwd, model: 'claude-sonnet-5' })
    sessionOf('comum').emit(event)
    await call(Channels.agentSend, 'comum', 'corrige o bug')
    expect(spy.observe.vigia).toHaveBeenCalledWith('comum', event)
    expect(spy.observe.board).toHaveBeenCalledWith('comum', cwd, event)
    expect(spy.observe.po).toHaveBeenCalledWith('comum', event)
    expect(spy.observe.memorista).toHaveBeenCalledWith('comum', event)
    expect(spy.note.vigia).toHaveBeenCalledWith('comum', cwd, 'corrige o bug')
    expect(spy.note.po).toHaveBeenCalledWith('comum', cwd, 'corrige o bug')
    expect(spy.note.memorista).toHaveBeenCalledWith('comum', cwd, 'corrige o bug')
  })

  it('agent:dispose limpa a conversa do registro de planejamento', async () => {
    await call(Channels.agentStart, { convId: 'plan-3', cwd, model: 'claude-sonnet-5', planning: { slug: 'checkout' } })
    await call(Channels.agentDispose, 'plan-3')
    for (const fn of observers()) fn.mockClear()
    // Mesmo id reaproveitado depois do descarte: já não é mais do Manager.
    await call(Channels.agentSend, 'plan-3', 'oi')
    expect(spy.note.vigia).toHaveBeenCalledWith('plan-3', '', 'oi')
  })

  it('slug inválido é recusado na fronteira, sem criar sessão', async () => {
    const before = spy.sessions.length
    await expect(
      call(Channels.agentStart, { convId: 'plan-x', cwd, model: 'claude-sonnet-5', planning: { slug: '../fora' } })
    ).rejects.toThrow(/slug do planejamento inválido/)
    expect(spy.sessions.length).toBe(before)
  })
})
