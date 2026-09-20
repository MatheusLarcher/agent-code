import { describe, expect, it, vi } from 'vitest'

// index.ts é o entrypoint do processo main: registra centenas de handlers de
// IPC e, no topo do módulo, referencia `app`/`BrowserWindow`/etc de forma
// síncrona. Fora do runtime do Electron, `import 'electron'` não devolve o
// objeto real — por isso cada dependência transitiva pesada é mockada aqui,
// só o suficiente para `registerIpc()` (exportado só para este teste) rodar
// sem passar pelo `app.whenReady()` que dispara o boot inteiro do app.

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()

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
vi.mock('./providerFailover', () => ({ ProviderFailoverSession: class {} }))
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
  loadConfig: () => ({}),
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
    repository: () => ({ listLlmCalls, listLlmUsageTotals }),
    canMutate: () => true,
    status: vi.fn(),
    subscribe: vi.fn(),
    subscribeChanges: vi.fn()
  }
}))
vi.mock('./persistence/leaseKeeper', () => ({ ConversationLeaseKeeper: class {} }))
vi.mock('./downloadAllowlist', () => ({
  DownloadAllowlist: class {
    track(): void {}
  },
  downloadablesFromMessages: vi.fn()
}))
vi.mock('./vigia/vigia', () => ({ Vigia: class { observe(): void {} } }))
vi.mock('./board/boardService', () => ({ BoardService: class { observe(): void {} } }))
vi.mock('./po/po', () => ({ Po: class { observe(): void {} } }))
vi.mock('./memoria/memorista', () => ({ Memorista: class { observe(): void {} } }))
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

const { Channels } = await import('../shared/ipc')
const { registerIpc } = await import('./index')

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
