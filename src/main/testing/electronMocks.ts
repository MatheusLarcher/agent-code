/**
 * Mocks compartilhados pelos testes que carregam o `index.ts` do main.
 *
 * index.ts é o entrypoint do processo main: registra centenas de handlers de
 * IPC e, no topo do módulo, referencia `app`/`BrowserWindow`/etc de forma
 * síncrona. Fora do runtime do Electron, `import 'electron'` não devolve o
 * objeto real — por isso cada dependência transitiva pesada é mockada aqui,
 * só o suficiente para `registerIpc()` (exportado só para os testes) rodar sem
 * passar pelo `app.whenReady()` que dispara o boot inteiro do app.
 *
 * Uso: importe este módulo ANTES de `await import('../index')` (import estático
 * no topo do teste). Os espiões exportados são os mesmos que os mocks usam.
 */
import { vi } from 'vitest'

/** Handlers registrados por `ipcMain.handle`, por canal. */
export const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

/** Chama um handler de IPC registrado, como o renderer faria. */
export const callIpc = (channel: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(channel)!(null, ...args))

/** Sessão criada pelo agent:start (com o `emit` do tee que ele entregou a ela). */
export type CreatedSession = {
  opts: { convId: string; model?: string; effort?: string; inboundMcp?: unknown }
  emit: (event: unknown) => void
  send: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  injectNow: ReturnType<typeof vi.fn>
  pinModel: ReturnType<typeof vi.fn>
}

/** Espiões: os quatro observadores, as sessões criadas e o que o `start()` delas devolve. */
export const spy = {
  observe: { vigia: vi.fn(), board: vi.fn(), po: vi.fn(), memorista: vi.fn() },
  note: { vigia: vi.fn(), po: vi.fn(), memorista: vi.fn(), board: vi.fn(async () => undefined) },
  sessions: [] as CreatedSession[],
  planningConfig: { model: 'claude-opus-5-5', effort: 'high' },
  /** Resultado dos próximos `start()` (vazio = sobe; promessa = subida que o teste solta). */
  startResults: [] as Array<boolean | Promise<boolean>>
}

/** Portão do lease: com `p`, o `acquireConversationLease` espera até o teste soltar. */
export const leaseGate = { p: null as Promise<void> | null }
/** Portão da retomada: com `p`, o `sessionResumeReady` (1º passo do preparo) espera. */
export const resumeGate = { p: null as Promise<void> | null }
/** Leases entregues pelo repositório falso (cada um com um token próprio). */
export const leasesAcquired: Array<{ token: string }> = []
/** Soltura direta no repositório (lease adquirido e não instalado). */
export const leaseReleases = vi.fn(async (_lease: unknown) => undefined)
/** Keepers criados: o lease de cada um e o espião da soltura. */
export const keepers: Array<{ lease: { token?: string }; release: ReturnType<typeof vi.fn> }> = []

export const listLlmCalls = vi.fn()
export const listLlmUsageTotals = vi.fn()
export const listContextTurns = vi.fn(async () => [])
export const readContextTurn = vi.fn(async () => null)
export const revealContextSecret = vi.fn(async (): Promise<string | null> => null)

export const sessionsOf = (convId: string): CreatedSession[] => spy.sessions.filter((s) => s.opts.convId === convId)

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app',
    getPath: () => '/app-data',
    getVersion: () => '0.0.0',
    quit: vi.fn(),
    whenReady: () => new Promise(() => {}),
    on: vi.fn(),
    requestSingleInstanceLock: () => true,
    setAppUserModelId: vi.fn()
  },
  Notification: class {
    static isSupported(): boolean {
      return false
    }
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
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: {},
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {}
}))

vi.mock('../browserController', () => ({ BrowserController: class {} }))
vi.mock('../agentSession', () => ({ AgentSession: class {} }))
vi.mock('../providerFailover', () => ({
  ProviderFailoverSession: class {
    send = vi.fn(async () => undefined)
    dispose = vi.fn()
    injectNow = vi.fn(() => true)
    pinModel = vi.fn()
    constructor(private readonly opts: CreatedSession['opts'], _factory: unknown, emit: (event: unknown) => void) {
      spy.sessions.push({ opts, emit, send: this.send, dispose: this.dispose, injectNow: this.injectNow, pinModel: this.pinModel })
    }
    async start(): Promise<boolean> {
      return spy.startResults.shift() ?? true
    }
    liveOptions(): CreatedSession['opts'] {
      return this.opts
    }
  }
}))
vi.mock('../appRestart', () => ({ AppRestartCoordinator: class {} }))
vi.mock('../appRestartRuntime', () => ({ configureAppRestart: vi.fn(), appRestart: null }))
vi.mock('../appRelauncher', () => ({ armAppRelauncher: vi.fn() }))
vi.mock('../remote/remoteServer', () => ({ RemoteServer: class { broadcast(): void {} } }))
vi.mock('../remote/relayClient', () => ({ RelayClient: class {} }))
vi.mock('../remote/remotePairing', () => ({ RemotePairingStore: class {} }))
vi.mock('../remote/buildApk', () => ({ buildRemoteApk: vi.fn() }))
vi.mock('../config', () => ({
  ensureConfigLoaded: vi.fn(),
  initializeConfigPersistence: vi.fn(),
  loadConfig: () => ({ planning: spy.planningConfig, typesafe: { allowedAutoModels: [] } }),
  updateConfig: vi.fn()
}))
vi.mock('../voiceService', () => ({
  registerVoiceIpc: vi.fn(),
  speak: vi.fn(),
  speechParts: vi.fn(() => []),
  stopVoice: vi.fn(async () => {}),
  transcribe: vi.fn()
}))
vi.mock('../voiceComponents', () => ({ registerVoiceComponentIpc: vi.fn() }))
vi.mock('../android/androidToolchainIpc', () => ({ registerAndroidToolchainIpc: vi.fn() }))
vi.mock('../speech', () => ({ stopLocalSpeech: vi.fn(), transcribeLocal: vi.fn() }))
vi.mock('../auth', () => ({ isAuthenticated: vi.fn(), logoutClaude: vi.fn() }))
vi.mock('../login', () => ({ runClaudeLogin: vi.fn() }))
// Contas Claude: uma conta só (a da máquina), como antes das contas existirem.
vi.mock('../accounts', () => ({
  claudeAccounts: {
    isConnected: vi.fn(async () => true),
    list: vi.fn(async () => []),
    ensureLoaded: vi.fn(async () => {}),
    hasExtraAccounts: vi.fn(() => false),
    candidates: vi.fn(async () => [])
  },
  configureAccountLogin: vi.fn(),
  conversationAccount: vi.fn(() => 'default'),
  accountSwitchDepsFor: vi.fn(() => undefined),
  forgetConversationAccount: vi.fn(),
  observerEnvFor: vi.fn(async () => undefined),
  queryAllAccountsUsage: vi.fn(async () => []),
  queryAccountUsage: vi.fn(async () => ({ accountId: 'default', reading: null, fresh: false })),
  recordSessionRateLimit: vi.fn(),
  resolveSessionAccount: vi.fn(async () => 'default'),
  startAccountSync: vi.fn()
}))
vi.mock('../codexAuth', () => ({
  codexStatus: vi.fn(async () => ({ connected: false })),
  codexLogout: vi.fn(),
  initializeCodexAuthPersistence: vi.fn(),
  runCodexLogin: vi.fn(),
  isCodexConnected: vi.fn()
}))
vi.mock('../codexProxy', () => ({ onCodexRateLimit: vi.fn() }))
vi.mock('../store', () => ({ initStore: vi.fn(), getCacheInfo: vi.fn(), setCacheDir: vi.fn() }))
vi.mock('../persistence/lifecycle', () => ({
  storageLifecycle: {
    repository: () => ({
      listLlmCalls,
      listLlmUsageTotals,
      listContextTurns,
      readContextTurn,
      acquireConversationLease: async () => {
        await (leaseGate.p ?? Promise.resolve())
        const lease = { token: `L${leasesAcquired.length + 1}` }
        leasesAcquired.push(lease)
        return lease
      },
      releaseConversationLease: leaseReleases,
      sessionResumeReady: async () => {
        await (resumeGate.p ?? Promise.resolve())
        return true
      },
      createSessionStore: () => ({})
    }),
    canMutate: () => true,
    status: vi.fn(() => ({ state: 'sqlite' })),
    subscribe: vi.fn(),
    subscribeChanges: vi.fn()
  }
}))
vi.mock('../persistence/leaseKeeper', () => ({
  ConversationLeaseKeeper: class {
    release = vi.fn(async (): Promise<void> => {})
    constructor(_repository: unknown, lease: { token?: string }) {
      keepers.push({ lease, release: this.release })
    }
    start(): this {
      return this
    }
  }
}))
vi.mock('../downloadAllowlist', () => ({
  DownloadAllowlist: class {
    track(): void {}
  },
  downloadablesFromMessages: vi.fn()
}))
vi.mock('../vigia/vigia', () => ({
  Vigia: class {
    observe = spy.observe.vigia
    noteUserMessage = spy.note.vigia
    dispose(): void {}
  }
}))
vi.mock('../board/boardService', () => ({
  BoardService: class {
    observe = spy.observe.board
    resumeTurn = spy.note.board
    dispose(): void {}
  }
}))
vi.mock('../po/po', () => ({
  Po: class {
    observe = spy.observe.po
    noteUserMessage = spy.note.po
    dispose(): void {}
  }
}))
vi.mock('../memoria/memorista', () => ({
  Memorista: class {
    observe = spy.observe.memorista
    noteUserMessage = spy.note.memorista
    dispose(): void {}
  }
}))
vi.mock('../memoria/memoriasUsadas', () => ({ forgetUsedMemories: vi.fn(), usedMemories: new Set() }))
vi.mock('../persistence/kvFacade', () => ({
  configureKvRepositoryOffline: vi.fn(),
  readPersistedKv: vi.fn(),
  writePersistedKv: vi.fn()
}))
vi.mock('../persistence/hashes', () => ({ hashJson: vi.fn(), normalizeJson: vi.fn() }))
vi.mock('../persistence/projectIdentity', () => ({
  attachProjectIdentity: vi.fn(),
  isMissingProjectFolderError: vi.fn(),
  preserveProjectIdentityForMissingPersistedWrite: vi.fn()
}))
vi.mock('../conversationParquet', () => ({ dailyParquetPath: vi.fn(), exportConversationsParquet: vi.fn() }))
vi.mock('../persistence/conversationWriteRecovery', () => ({
  storageErrorForIpc: vi.fn(),
  upsertConversationWithLeaseRecovery: vi.fn(),
  deleteConversationWithLeaseRecovery: vi.fn(),
  sessionLeaseRenewal: vi.fn()
}))
vi.mock('../attachments', () => ({
  saveAttachments: vi.fn(),
  resolvePastedPath: vi.fn(),
  downloadPastedUrl: vi.fn(),
  buildAttachmentNote: vi.fn(),
  imagesAsFiles: vi.fn(() => []),
  splitImagesForNote: vi.fn(() => ({ refs: [], toSave: [] }))
}))
vi.mock('../memoryCurator', () => ({ startMemoryCuratorScheduler: vi.fn() }))
vi.mock('../tasks/taskRuntime', () => ({ taskLedger: vi.fn() }))
vi.mock('../tasks/taskBoard', () => ({ buildTaskBoard: vi.fn(), buildTaskDetail: vi.fn() }))
vi.mock('../tasks/taskReaper', () => ({ startTaskReaper: vi.fn() }))
vi.mock('../memory/memoryRuntime', () => ({
  configureSecretVault: vi.fn(),
  deleteSecret: vi.fn(),
  listSecretMetadata: vi.fn(),
  readSecretForReveal: revealContextSecret,
  memoryService: {},
  restoreVault: vi.fn(),
  secretSink: vi.fn()
}))
vi.mock('../restartGuardFile', () => ({ startRestartGuardFile: vi.fn() }))
vi.mock('../sleepGuard', () => ({ startSleepGuard: vi.fn() }))
vi.mock('../windowsControl/service', () => ({ windowsControl: {} }))
vi.mock('../skillDiscovery', () => ({ discoverSkills: vi.fn() }))
vi.mock('../projectIcon', () => ({ readProjectIcon: vi.fn() }))
vi.mock('../skillManager', () => ({ syncCacheSkills: vi.fn() }))
vi.mock('../typesafe', () => ({ resolveAutoStart: vi.fn() }))
vi.mock('../typesafe/client', () => ({ typeSafeConfigured: vi.fn() }))
