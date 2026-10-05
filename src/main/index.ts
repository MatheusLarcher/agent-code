import { app, BrowserWindow, ipcMain, dialog, Notification, powerMonitor, powerSaveBlocker, safeStorage, shell } from 'electron'
import type { MessageBoxOptions } from 'electron'
import { openUrlExternally } from './openInBrowser'
import { randomUUID } from 'node:crypto'
import { getSessionInfo, getSessionMessages, importSessionToStore } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { join, basename, extname } from 'node:path'
import {
  stat as fsStat,
  copyFile as fsCopyFile,
  access as fsAccess,
  readdir as fsReaddir,
  readFile as fsReadFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { BrowserController } from './browserController'
import { AgentSession, type MessageOrigin } from './agentSession'
import { ProviderFailoverSession } from './providerFailover'
import { createConversationLock } from './conversationLock'
import { createStepRunner, RESUME_PREPARE_DEADLINE_MS } from './sessionSteps'
import { initSessionLog, logSession } from './sessionLog'
import { initFreezeLog, logFreezes } from './freezeLog'
import { installJsProfilingPolicy, rendererIndexMatcher } from './jsProfilingPolicy'
import { SessionLeases } from './sessionLeases'
import { AppRestartCoordinator } from './appRestart'
import { configureAppRestart, appRestart } from './appRestartRuntime'
import { armAppRelauncher } from './appRelauncher'
import { RemoteServer } from './remote/remoteServer'
import { McpInbound, type LiveSessionState, type McpSend } from './mcpInbound/mcpInbound'
import { MCP_NO_CONTINUE_WARNING, NO_LIVE_SESSION } from '../shared/mcpInbound'
import type { AccountSwitchDeps } from './accounts/switchDeps'
import { ollamaSelectable, selectableModelIds } from '../shared/selectableModels'
import { registerProviderStatusIpc } from './providerStatus'
import { isSandboxPath, sandboxCreateResult, sandboxRoot } from './sandbox'
import { secondInstanceReveal, wantsMinimized } from './mcpInbound/windowStartup'
import { RelayClient } from './remote/relayClient'
import { RemotePairingStore } from './remote/remotePairing'
import { buildRemoteApk } from './remote/buildApk'
import {
  AUTO_MODEL,
  Channels,
  CLAUDE_MODELS,
  DEFAULT_CONFIG,
  isAutoEffort,
  isAutoModel,
  OPENAI_MODELS,
  REMOTE_RELAY_WS,
  type BoardItemStatus
} from '../shared/ipc'
import {
  ensureConfigLoaded,
  initializeConfigPersistence,
  isConfigLoaded,
  loadConfig,
  reloadConfigPersistence,
  updateConfig
} from './config'
import { registerVoiceIpc, speak, speechParts, stopVoice, transcribe as transcribeVoice } from './voiceService'
import { registerVoiceComponentIpc } from './voiceComponents'
import { registerAndroidToolchainIpc } from './android/androidToolchainIpc'
import { claudeAuthProbe, isAuthenticated, logoutClaude } from './auth'
import { claudeAuthExpiry, claudeConnectedForCard } from './authExpiry'
import { runClaudeLogin } from './login'
import {
  claudeAccounts,
  configureAccountLogin,
  accountSwitchDepsFor,
  conversationAccount,
  forgetConversationAccount,
  observerEnvFor,
  queryAccountUsage,
  queryAllAccountsUsage,
  recordSessionRateLimit,
  resolveSessionAccount,
  startAccountSync,
  stopAccountSync,
  storableSessionAccount
} from './accounts'
import { registerClaudeAccountsIpc } from './accounts/accountsIpc'
import { setClaudeObserverEnvResolver } from './observerQuery'
import { registerOutboxIpc } from './outboxIpc'
import { registerCentralIpc, type CentralIpcHandle } from './central/centralIpc'
import { codexStatus, codexLogout, initializeCodexAuthPersistence, runCodexLogin, isCodexConnected } from './codexAuth'
import { onCodexRateLimit } from './codexProxy'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { initStore, getCacheInfo, setCacheDir } from './store'
import { storageLifecycle } from './persistence/lifecycle'
import { ConversationLeaseKeeper } from './persistence/leaseKeeper'
import { DownloadAllowlist, downloadablesFromMessages } from './downloadAllowlist'
import { Vigia } from './vigia/vigia'
import { BoardService } from './board/boardService'
import { registerPlanningIpc, type PlanningIpcHandle } from './planning/planningIpc'
import { registerHandoffIpc } from './handoffTracking/handoffIpc'
import { HandoffTracker } from './handoffTracking/handoffTracker'
import { startHandoffSweep } from './handoffTracking/handoffSweep'
import { exportFlowPdf } from './planning/flowPdfExport'
import { PlanningConversations, planningStartOptions } from './planning/planningConversations'
import { setPlanningDataRoot } from './planning/planningRoot'
import { registerConversationTitleIpc } from './titles/conversationTitleIpc'
import { Po } from './po/po'
import { createPoLogWriter } from './po/poLog'
import { Memorista } from './memoria/memorista'
import { forgetUsedMemories, usedMemories } from './memoria/memoriasUsadas'
import { configureKvRepositoryOffline, readPersistedKv, writePersistedKv } from './persistence/kvFacade'
import { StorageError, type ConversationLease, type ConversationRecord, type PersistenceRepository } from './persistence/types'
import { hashJson, normalizeJson } from './persistence/hashes'
import { replayLocalTranscript, verifyMirroredSession } from './persistence/mirrorReplay'
import { replayDedupStore } from './persistence/replayDedup'
import { activeContextHistory, activeReplayStore, activeResumeMarker, activeSessionStore, activeTokenUsage } from './persistence/activeRepository'
import { registerContextIpc } from './contextSnapshot/ipc'
import { registerMockupScheme, setupOfficeMockup } from './officeMockup/mockupElectron'
import { OfficeCallCenter, parseCallsState } from './officeCallCenter'
import { registerMemoryReadIpc } from './memory/memoryReadIpc'
import { setOfficeCallSink } from './officeCallRuntime'
import { createSessionStorageRecovery } from './sessionStorageRecovery'
import {
  attachProjectIdentity,
  isMissingProjectFolderError,
  preserveProjectIdentityForMissingPersistedWrite
} from './persistence/projectIdentity'
import { dailyParquetPath, exportConversationsParquet } from './conversationParquet'
import { relocateLocalLeftovers, type LeftoverRelocation } from './localLeftovers'
import {
  deleteConversationWithLeaseRecovery,
  sessionLeaseRenewal,
  storageErrorForIpc,
  upsertConversationWithLeaseRecovery
} from './persistence/conversationWriteRecovery'
import { saveAttachments, resolvePastedPath, downloadPastedUrl, buildAttachmentNote, splitImagesForNote, stashDraftAttachment, discardDraftAttachments, promoteDraftAttachments } from './attachments'
import { startMemoryCuratorScheduler } from './memoryCurator'
import { taskLedger } from './tasks/taskRuntime'
import { buildTaskBoard, buildTaskDetail, type TaskBoardQuery } from './tasks/taskBoard'
import { startTaskReaper } from './tasks/taskReaper'
import { configureSecretVault, deleteSecret, listSecretMetadata, memoryService, readSecretForReveal, restoreVault, secretSink } from './memory/memoryRuntime'
import { startRestartGuardFile } from './restartGuardFile'
import { startSleepGuard } from './sleepGuard'
import { windowsControl } from './windowsControl/service'
import { chromeBridgeStatus, openInstall as openChromeInstall, startChromeBridge, stopChromeBridge } from './chromeBridge/runtime'
import { discoverSkills } from './skillDiscovery'
import { readProjectIcon } from './projectIcon'
import { syncCacheSkills } from './skillManager'
import { autoModelCandidates, resolveAutoStart, type AutoLivePair, type AutoStartDecision } from './typesafe'
import { typeSafePause, TYPESAFE_BLOCKING_TIMEOUT_MS } from './typesafe/pause'
import { typeSafeConfigured } from './typesafe/client'
import { listProjectDir, MENTION_IGNORE } from './projectFiles'
import type {
  AgentMessageKind,
  TurnEndWait,
  ChatEvent,
  AppConfig,
  BrowserInput,
  FileAttachment,
  FileBytes,
  FileRefAttachment,
  ImageAttachment,
  MentionHit,
  ProjectDirListing,
  ProjectNode,
  ProjectTree,
  ResolvedPastedRef,
  SkillInfo,
  PermissionResponse,
  RemoteStatePayload,
  StartAgentOptions,
  TabKind,
  PostgresConnectionDraft,
  ConversationUpsertDto,
  ConversationDeleteDto,
  ConversationQueryDto,
  SecretVaultItem,
  MemoryConflictItem,
  TokenUsageHistory
} from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
let stopMemoryCurator: (() => void) | null = null
let stopTaskReaper: (() => void) | null = null
let stopHandoffSweep: (() => void) | null = null
let stopRestartGuardFile: (() => void) | null = null
let stopSleepGuard: (() => void) | null = null
/** Handlers planning:* e os vigias de pasta deles (fechados ao sair). */
let planningIpc: PlanningIpcHandle | null = null
/** O HTML do agente na TV do Escritório (protocolo agent-mockup + janela de captura). */
let officeMockup: ReturnType<typeof setupOfficeMockup> | null = null
/** Handlers central:* e o índice de conversas da Central (aquecido depois do armazenamento). */
let centralIpc: CentralIpcHandle | null = null
// Os planejamentos moram na pasta de dados do app (<dataDir>/planning/<projeto>/),
// a mesma das memórias: acompanham o usuário entre PCs. Lida a cada chamada —
// o usuário pode trocar a pasta de dados com o app aberto.
setPlanningDataRoot(() => getCacheInfo().dir)
let closeRequested = false
let closeReady = false
let closeRequestTimer: ReturnType<typeof setInterval> | null = null
let quitRequested = false
let quitReady = false
let storageClosePromise: Promise<void> | null = null
let parquetExportPromise: Promise<unknown> | null = null
let restartAfterStorageTransition = false
const pendingStorageFlushes = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>()

configureAppRestart(new AppRestartCoordinator({
  arm: () => armAppRelauncher({
    packaged: app.isPackaged, appRoot: app.getAppPath(), resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'), executable: process.execPath, pid: process.pid,
    createdAt: process.getCreationTime(), portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE
  }),
  flush: async () => {
    if (quitRequested || closeRequested) throw new Error('Outro fechamento já está em andamento.')
    await requestStorageFlush()
  },
  quit: () => app.quit(),
  report: (message) => console.warn('[app-restart]', message)
}))

// One independent agent session per conversation — they run concurrently, so
// switching/sending in one conversation never cancels another's running task.
const sessions = new Map<string, ProviderFailoverSession>()
/** Pasta do projeto de cada conversa viva. O quadro é por projeto, e quem
 *  precisa dela (PO) age fora do caminho onde `opts.cwd` está em escopo. */
const sessionCwds = new Map<string, string>()
/** O par modelo+esforço em que cada conversa com alguma dimensão em Automático
 *  está rodando AGORA. Existe primeiro por custo de boot: o par é fixo pela vida
 *  da sessão do SDK, então mudar de par obriga a recriar a sessão — e recriá-la
 *  quando a escolha do turno repete a anterior seria pagar um boot por nada. O
 *  `decided` diz, POR DIMENSÃO, se o valor saiu de uma decisão do TypeSafe: só a
 *  dimensão decidida entra na histerese do turno seguinte (ver `AutoLivePair`
 *  em `typesafe/execution.ts`). */
const autoSessions = new Map<string, AutoLivePair>()
/** Conversas que são sessões do Agent Manager (Tela de Planejamento): não
 *  alimentam vigia, quadro, PO nem memorista (ver planning/planningConversations.ts). */
const planningConversations = new PlanningConversations()

// Which files the agent actually offered for download. Fed from the event tee
// below, consulted by the `fileDownload` handler.
const downloadAllowlist = new DownloadAllowlist()
// Prazos por passo das operações que trocam a sessão (sessionSteps.ts): o lock
// da conversa não tem prazo; cada passo que pode travar dentro dele tem.
const sessionSteps = createStepRunner()
// Lease de cada conversa com sessão viva (sessionLeases.ts): aquisição com
// prazo, lease atrasado solto ao chegar, keeper de uma operação nunca
// sobrescrito pelo de outra.
const sessionLeases = new SessionLeases<ConversationLeaseKeeper, PersistenceRepository>({
  repository: () => storageLifecycle.repository(),
  steps: sessionSteps,
  keeper: (convId, lease, isInstalled) => newLeaseKeeper(convId, lease, isInstalled)
})

/** Lease sendo solto no fim do turno (onTurnComplete), por conversa. */
const turnLeaseReleases = new Map<string, Promise<void>>()
/** Prazo máximo do `agent:wait-turn-end`: depois dele a fila segue mesmo assim. */
const TURN_END_WAIT_MS = 45_000

async function releaseSessionLease(convId: string): Promise<void> {
  await sessionLeases.release(convId)
}

async function acquireSessionLease(convId: string): Promise<{ repository: PersistenceRepository; lease: ConversationLease }> {
  return sessionLeases.acquire(convId)
}

function newLeaseKeeper(convId: string, lease: ConversationLease, isInstalled: () => boolean): ConversationLeaseKeeper {
  // Only a lease that provably moved to another installation ends the session.
  // Killing a running turn because one heartbeat could not reach Postgres is
  // what made tasks die mid-run on a connection blip; the keeper retries those.
  // A database that is really gone still lands on the `postgres-offline` path,
  // which waits for the turn to go idle before disposing the session.
  // O heartbeat segue o repositório ATIVO, não o da aquisição: depois de uma
  // reconexão automática o antigo está fechado (pool encerrado) e renovar nele
  // falharia até o lease vencer com o turno ainda rodando. Offline, `repository()`
  // lança STORAGE_OFFLINE — transitório para o keeper, que tenta de novo.
  // `async` de propósito: o `throw` síncrono de `repository()` vira promessa
  // rejeitada, que o `.catch` do `release()` do keeper absorve (síncrono, ele
  // escaparia como rejeição não tratada no descarte das sessões offline).
  const leaseRepository = {
    renewConversationLease: async (held: ConversationLease) =>
      storageLifecycle.repository().renewConversationLease(held),
    releaseConversationLease: async (held: ConversationLease) =>
      storageLifecycle.repository().releaseConversationLease(held)
  }
  const keeper: ConversationLeaseKeeper = new ConversationLeaseKeeper(leaseRepository, lease, {
    onLost: (error) => {
      if (!isInstalled()) return
      sessionLeases.forget(convId, keeper)
      // Descartada = fora do mapa na hora: ninguém envia para ela. O turno de
      // tarefa MCP que estava aberto nela se perdeu (erro, nunca `rodando`).
      const lost = sessions.get(convId)
      logSession('lease-lost', { convId, reason: 'lease-lost', background: !!lost?.hasBackgroundWork() })
      sessions.delete(convId)
      lost?.dispose()
      // O dispose não emite fim de turno: sem isto o acompanhamento seguiria
      // contando tempo ativo de um turno que morreu com o lease.
      handoffTracker.sessionEnded(convId)
      if (lost) mcpInbound.onSessionInstalled(convId)
      send(Channels.agentEvent, {
        convId,
        event: { kind: 'error', id: randomUUID(), text: `Lease perdido: ${error.message}` }
      })
    },
    onTransientFailure: (error) => {
      console.warn(`[lease] renovação falhou para ${convId}, tentando de novo:`, error)
    }
  }).start()
  return keeper
}

/** `prepareSessionResume` com prazo total (RESUME_PREPARE_DEADLINE_MS). Estourou:
 *  a subida falha com erro claro; a importação atrasada segue rastreada e a
 *  próxima preparação da mesma conversa espera por ela. */
function prepareSessionResumeWithin(
  repository: PersistenceRepository,
  convId: string,
  cwd: string,
  sessionId: string
): Promise<void> {
  return sessionSteps.run(`${convId}:resume`, 'A preparação da retomada da conversa', RESUME_PREPARE_DEADLINE_MS, () =>
    prepareSessionResume(repository, convId, cwd, sessionId)
  )
}

async function prepareSessionResume(
  repository: PersistenceRepository,
  convId: string,
  cwd: string,
  sessionId: string
): Promise<void> {
  if (await repository.sessionResumeReady(convId, sessionId)) return
  const store = repository.createSessionStore(convId)
  await importSessionToStore(sessionId, store, { dir: cwd, includeSubagents: true }).catch(() => undefined)
  const [info, entries] = await Promise.all([
    getSessionInfo(sessionId, { dir: cwd, sessionStore: store }),
    store.load({ projectKey: convId, sessionId })
  ])
  if (!info || !entries?.length) {
    throw new StorageError('SESSION_HANDOFF_INCOMPLETE', 'A sessão não possui transcript íntegro para retomada.')
  }
  await getSessionMessages(sessionId, { dir: cwd, sessionStore: store })
  await repository.markSessionResumeReady(convId, sessionId, true, hashJson(normalizeJson(entries)))
}

// One independent browser per conversation. Only the conversation currently
// shown in the panel (`activeConvId`) streams its frames/state to the renderer;
// the others keep their page alive in the background.
const browsers = new Map<string, BrowserController>()
let activeConvId: string | null = null
// Panel size (CSS px) the renderer last reported; every browser adopts it so the
// visible page always matches the panel the user is looking at.
let desiredViewport = { width: 1280, height: 800 }

const EMPTY_BROWSER_STATE = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  launched: false,
  tabs: []
}

// O observador paralelo: assiste ao tee de eventos e, quando uma premissa do
// trabalho depende de algo que só o usuário sabe, levanta um chip na tela. Não
// fala com o agente, não interrompe turno, e falha em silêncio.
const vigia = new Vigia({
  config: () => loadConfig().vigia,
  emit: (alert) => send(Channels.vigiaAlert, alert)
})

// O quadro de tarefas do projeto. Lê o mesmo tee do vigia, mas só o snapshot
// autoritativo do CLI; sem repositório gravável ele simplesmente não grava (o
// chat nunca pode quebrar porque o quadro não conseguiu persistir).
const board = new BoardService({
  repository: () => (storageLifecycle.canMutate() ? storageLifecycle.repository() : null),
  // O acompanhamento dos envios de handoff relê os cartões quando o PO (ou
  // qualquer escrita) muda o quadro. Referência preguiçosa: declarado abaixo.
  onChanged: (projectId) => {
    send(Channels.boardChanged, { projectId })
    handoffTracker.boardChanged(projectId)
  },
  // O fechamento de turno espera a auditoria do PO antes de devolver para "a
  // fazer" o que ficou em andamento — reabrir primeiro desfaria o "concluído"
  // que ele ainda ia gravar. A referência é preguiçosa de propósito: `po` é
  // declarado abaixo (ele depende do `board`), e esta função só roda quando um
  // turno termina, muito depois de os dois existirem. O tipo de retorno é
  // explícito porque sem ele o `tsc` tentaria inferir `po` para tipar `board` e
  // `board` para tipar `po` — o mesmo ciclo, agora entre os dois tipos.
  poSettled: (convId: string): Promise<void> => po.settled(convId),
  // PO desligado: o quadro é só do agente principal (nada de reabrir no fim
  // do turno nem de promover na retomada).
  poEnabled: (): boolean => (loadConfig().board ?? DEFAULT_CONFIG.board).po.enabled,
  // O drag-and-drop no Quadro controla o agente de verdade: manda mensagem
  // (reaproveitando o MESMO `AgentSession.send` do Composer, que já enfileira
  // sozinho) ou interrompe o turno (mesmo caminho de `Channels.agentInterrupt`).
  // `sessions` é módulo-privado deste arquivo — por isso a injeção, em vez de
  // o BoardService importá-lo.
  sendToSession: async (convId: string, text: string): Promise<boolean> => {
    const s = sessions.get(convId)
    if (!s) return false
    await s.send(text)
    return true
  },
  interruptSession: async (convId: string): Promise<boolean> => {
    const s = sessions.get(convId)
    if (!s) return false
    await s.interrupt()
    return true
  }
})

// O PO: audita o quadro na abertura do turno (o pedido vira cartão antes de o
// trabalho começar) e no fechamento (o que terminou de fato). Escreve no
// quadro, nunca no chat; falha em silêncio.
const po = new Po({
  config: () => loadConfig().board ?? DEFAULT_CONFIG.board,
  board,
  // Uma linha por rodada em <userData>/po-decisions.log (ver po/poLog.ts).
  decisionLog: createPoLogWriter(),
  diagnose: (diagnostic) => send(Channels.poProviderDiagnostic, {
    ...diagnostic,
    id: randomUUID(),
    at: Date.now()
  })
})

// O acompanhamento dos envios de handoff (handoffTracking/): só conversas com
// `opts.handoff`; observa turnos, perguntas e o Quadro e grava status e tempo.
const handoffTracker = new HandoffTracker({
  repository: () => (storageLifecycle.canMutate() ? storageLifecycle.repository() : null),
  board,
  poEnabled: () => (loadConfig().board ?? DEFAULT_CONFIG.board).po.enabled,
  onChanged: (conversationId) => send(Channels.handoffChanged, { conversationId })
})

// O memorista: o terceiro observador. Lê o fim de cada turno e grava sozinho o
// que vale lembrar amanhã. A memória e o cofre são funções, não valores: os dois
// só existem depois que a pasta de dados ativa carrega (`configureMemoryRuntime`),
// muito depois deste módulo ser avaliado — capturar o valor aqui congelaria um
// `null` e o observador nunca escreveria nada.
const memorista = new Memorista({
  config: () => loadConfig().memorista ?? DEFAULT_CONFIG.memorista,
  memory: () => memoryService(),
  vault: () => secretSink(),
  // O que o agente já tinha em mãos neste turno: um fato já injetado não vira
  // memória nova, vira duplicata (ver memoriasUsadas.ts).
  usedMemories: (convId) => usedMemories(convId),
  diagnose: (diagnostic) => send(Channels.memoristaProviderDiagnostic, {
    ...diagnostic,
    id: randomUUID(),
    at: Date.now()
  })
})

function send(channel: string, payload: unknown): void {
  const window = mainWindow
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  try {
    window.webContents.send(channel, payload)
  } catch {
    // Renderer teardown can race a final status/change notification.
  }
}

function requestRendererCloseFlush(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!closeRequested) {
    closeRequested = true
    send(Channels.appCloseRequested, null)
  }
  if (!closeRequestTimer) {
    closeRequestTimer = setInterval(() => send(Channels.appCloseRequested, null), 100)
    closeRequestTimer.unref?.()
  }
}

async function closeStorageForQuit(): Promise<void> {
  storageClosePromise ??= (async () => {
    await Promise.all([...sessionLeases.keys()].map(releaseSessionLease))
    await parquetExportPromise?.catch(() => undefined)
    await storageLifecycle.close()
  })()
  await storageClosePromise
}

function requestStorageFlush(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve()
  const requestId = randomUUID()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStorageFlushes.delete(requestId)
      reject(new Error('O renderer não confirmou o flush de persistência.'))
    }, 15_000)
    timer.unref?.()
    pendingStorageFlushes.set(requestId, { resolve, reject, timer })
    send(Channels.storageFlushRequested, requestId)
  })
}

const storageTransitionHooks = {
  flushRenderer: requestStorageFlush,
  waitForIdleAgents: async (): Promise<void> => {
    // The caller has already obtained explicit user confirmation. Stop live
    // work now instead of allowing a long-running turn to hold the migration.
    for (const [convId, session] of sessions) {
      session.dispose()
      handoffTracker.sessionEnded(convId)
    }
    sessions.clear()
    await Promise.all([...sessionLeases.keys()].map(releaseSessionLease))
  }
}

async function confirmStorageTransitionStopsAgents(direction: 'postgres' | 'sqlite'): Promise<boolean> {
  const count = sessions.size
  if (!count) return true
  const target = direction === 'postgres' ? 'PostgreSQL' : 'SQLite'
  const options: MessageBoxOptions = {
    type: 'warning',
    buttons: ['Parar agents e migrar', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: `Migrar para ${target}`,
    message: `${count === 1 ? 'Existe 1 agent em execução' : `Existem ${count} agents em execução`}.`,
    detail: `A migração para ${target} precisa interromper ${count === 1 ? 'esse agent' : 'esses agents'}. O histórico pendente será salvo antes da troca e o aplicativo reiniciará automaticamente.`
  }
  const result = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  return result.response === 0
}

function relaunchAfterStorageTransition(): void {
  if (restartAfterStorageTransition) return
  restartAfterStorageTransition = true
  setTimeout(() => {
    app.relaunch()
    app.quit()
  }, 300).unref?.()
}

function assertStorageWritable(allowTransitionFlush = false): void {
  if (!storageLifecycle.canMutate()) {
    const status = storageLifecycle.status()
    throw new Error(status.error?.message ?? 'Persistência indisponível para gravação.')
  }
  const state = storageLifecycle.status().state
  if (!allowTransitionFlush && (state === 'activating-postgres' || state === 'deactivating-postgres')) {
    throw new StorageError('TRANSITION_IN_PROGRESS', 'A persistência está em transição.')
  }
}

async function updateAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  if ('windowsControlEnabled' in patch && typeof patch.windowsControlEnabled !== 'boolean') {
    throw new TypeError('windowsControlEnabled deve ser booleano.')
  }
  if ('chromeControlEnabled' in patch && typeof patch.chromeControlEnabled !== 'boolean') {
    throw new TypeError('chromeControlEnabled deve ser booleano.')
  }
  // Depois da carga: antes dela `loadConfig()` é o padrão, e comparar a key
  // real com a vazia faria parecer que ela mudou.
  await ensureConfigLoaded()
  const before = loadConfig().typesafe
  const next = await updateConfig(patch)
  // Chave nova salva ou Modo Automático religado: sai da pausa na hora.
  if (patch.typesafe && (next.typesafe.apiKey !== before.apiKey || (next.typesafe.enabled && !before.enabled))) {
    typeSafePause.reset()
  }
  if (patch.windowsControlEnabled !== undefined) {
    windowsControl.setEnabled(next.windowsControlEnabled)
    send(Channels.windowsControlChanged, next.windowsControlEnabled)
  }
  if (patch.chromeControlEnabled !== undefined) send(Channels.chromeControlChanged, next.chromeControlEnabled)
  return next
}

/** True if a path exists (used to avoid clobbering files in Downloads). */
async function fsExists(p: string): Promise<boolean> {
  try {
    await fsAccess(p)
    return true
  } catch {
    return false
  }
}

// Root of the smartfone-remote project (sibling of out/ → ../../ from out/main).
const REMOTE_ROOT = join(import.meta.dirname, '../../smartfone-remote')

// ---- "@" autocomplete: search project files/folders --------------------------

// MENTION_IGNORE (folders never worth walking) lives in ./projectFiles, shared with the file tree.

/** lowercase + strip accents, so "TÉST" matches "teste" (project filter rule). */
function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** Rank a candidate against the folded query; -1 means "no match" (drop it). */
function mentionScore(q: string, name: string, relPath: string, isDir: boolean): number {
  const n = foldText(name)
  const p = foldText(relPath)
  let base: number
  if (n === q) base = 100
  else if (n.startsWith(q)) base = 80
  else if (n.includes(q)) base = 60
  else if (p.includes(q)) base = 30
  else return -1
  return base + (isDir ? 3 : 0) // nudge folders up a touch, as the user asked for both
}

/**
 * Walk the project tree breadth-first (shallow entries first) and return files
 * and folders whose name/path contains `query`, accent- and case-insensitive.
 * Capped in both hits and nodes scanned so each keystroke stays cheap. An empty
 * query lists the project's top level (folders first).
 */
async function searchProjectEntries(root: string, query: string): Promise<MentionHit[]> {
  const MAX_HITS = 30
  const MAX_SCAN = 20000
  const q = foldText(query.trim())

  // Empty query → just the project's top level (folders first), no recursion.
  if (!q) {
    let top: import('node:fs').Dirent[]
    try {
      top = await fsReaddir(root, { withFileTypes: true })
    } catch {
      return []
    }
    return top
      .filter((e) => !(e.isDirectory() && MENTION_IGNORE.has(e.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, MAX_HITS)
      .map((e) => ({ path: e.name, name: e.name, isDir: e.isDirectory() }))
  }

  type Hit = MentionHit & { score: number }
  const hits: Hit[] = []
  const queue: string[] = [''] // relative dirs still to visit ('' = root)
  let scanned = 0

  while (queue.length && scanned < MAX_SCAN) {
    const rel = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsReaddir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (scanned >= MAX_SCAN) break
      scanned++
      const isDir = e.isDirectory()
      if (isDir && MENTION_IGNORE.has(e.name)) continue
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (isDir) queue.push(relPath)
      const score = mentionScore(q, e.name, relPath, isDir)
      if (score >= 0) hits.push({ path: relPath, name: e.name, isDir, score })
    }
  }
  hits.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path)
  )
  return hits.slice(0, MAX_HITS).map(({ path, name, isDir }) => ({ path, name, isDir }))
}

// ---- project map: the whole tree, for the "Projeto" graph view ----------------

/**
 * The project map's nodes: the N most RECENTLY MODIFIED files, plus every
 * folder needed to reach them.
 *
 * Showing the whole repo was the first version and it was the wrong picture —
 * hundreds of files nobody has touched in months, with the live work lost in
 * the middle. Sorting by mtime makes the map answer "what is moving in this
 * project", which is what it exists for. Anything the agent touches gets added
 * on the fly by the renderer even if it isn't in this list.
 *
 * The walk is still capped (MAX_SCAN) so a monorepo can't stall the main
 * process; `truncated` says the ranking only saw part of the repo.
 */
async function readProjectTree(root: string, keep: string[] = [], limit = 100): Promise<ProjectTree> {
  const MAX_SCAN = 8000
  const files: { path: string; name: string; mtimeMs: number }[] = []
  const queue: string[] = ['']
  let scanned = 0
  let truncated = false

  while (queue.length && scanned < MAX_SCAN) {
    const rel = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsReaddir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    const batch: Promise<void>[] = []
    for (const e of entries) {
      if (scanned >= MAX_SCAN) {
        truncated = true
        break
      }
      scanned++
      const isDir = e.isDirectory()
      // Dotfiles stay out: config noise on a map meant to show code.
      if (e.name.startsWith('.')) continue
      if (isDir && MENTION_IGNORE.has(e.name)) continue
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (isDir) {
        queue.push(relPath)
        continue
      }
      // stat per file is the price of ranking by mtime; fired in parallel per
      // directory so it's one round of I/O per folder, not one per file.
      batch.push(
        fsStat(join(root, relPath))
          .then((s) => {
            files.push({ path: relPath, name: e.name, mtimeMs: s.mtimeMs })
          })
          .catch(() => {
            /* vanished mid-scan — just leave it out */
          })
      )
    }
    await Promise.all(batch)
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const top = files.slice(0, limit)

  // Every ancestor folder of a kept file has to come along, otherwise the node
  // is an orphan and the graph drops it (and the travel animation would have
  // no route to walk).
  const out = new Map<string, ProjectNode>()
  for (const f of top) {
    const parts = f.path.split('/')
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/')
      if (!out.has(p)) out.set(p, { path: p, name: parts[i], isDir: true })
    }
    out.set(f.path, { path: f.path, name: f.name, isDir: false, mtimeMs: f.mtimeMs })
  }

  // Which of the caller's current nodes are actually gone from disk (as opposed
  // to just having dropped out of the ranking).
  const missing: string[] = []
  await Promise.all(
    keep.map(async (rel) => {
      if (!rel) return
      try {
        await fsAccess(join(root, rel))
      } catch {
        missing.push(rel)
      }
    })
  )

  return { nodes: [...out.values()], truncated: truncated || files.length > limit, missing }
}

// ---- "/" autocomplete: list the agent's skills --------------------------------

/**
 * List the skills available to the agent: project-local entries, the active
 * cache skill store and user-level `~/.claude/skills`. Deduped by name
 * (project wins), sorted alphabetically.
 */
async function listAgentSkills(projectRoot: string): Promise<SkillInfo[]> {
  return discoverSkills(projectRoot).map(({ name, description }) => ({ name, description }))
}

/**
 * Mensagens que acabaram de chegar do celular, esperando o `agent:send` que
 * fecha o círculo. A marca é consumida uma vez só e casa pelo TEXTO — assim uma
 * mensagem digitada no PC na mesma conversa não rouba o carimbo de celular.
 */
const pendingRemote = new Map<string, { text: string; at: number }>()
/** A volta pelo renderer é imediata, MAS a mensagem pode ficar na fila enquanto o
 *  agente termina o turno anterior — por isso a janela é larga, e não de segundos.
 *  Passou disso, a marca é lixo e a origem cai para o padrão (PC). */
const REMOTE_MARK_TTL_MS = 30 * 60_000

function markRemoteInbound(convId: string, text: string): void {
  pendingRemote.set(convId, { text, at: Date.now() })
}

/** Consome a marca (uma vez) e diz de onde a mensagem partiu. */
function takeOrigin(convId: string, outgoing: string): MessageOrigin {
  const mark = pendingRemote.get(convId)
  if (!mark) return 'pc'
  pendingRemote.delete(convId)
  const fresh = Date.now() - mark.at < REMOTE_MARK_TTL_MS
  return fresh && outgoing === mark.text ? 'celular' : 'pc'
}

// MCP de entrada (contrato Forgia → Agent Code): 127.0.0.1:47110–47149. A tarefa
// dá a mesma volta de uma mensagem do celular — main → renderer (cria/abre a
// conversa e despacha pela fila) → `agent:send` — e o status sai do tee de
// eventos da sessão. Sobe no boot, sem depender de janela nem de login.
// Exportado só para o index.test.ts (registro de tarefas nos testes de agent:send).
export const mcpInbound = new McpInbound({
  version: app.getVersion(),
  conversationExists: async (convId) =>
    (await storageLifecycle.repository().loadConversations({ ids: [convId] })).some(
      (c) => c.id === convId && !c.deletedAt
    ),
  // Conversa do Agent Manager (Conversation.mode === 'planning'): destino recusado.
  conversationIsPlanning: async (convId) =>
    (await storageLifecycle.repository().loadConversations({ ids: [convId] })).some(
      (c) => c.id === convId && !c.deletedAt && c.payload.mode === 'planning'
    ),
  deliverToRenderer: (d) => send(Channels.mcpInbound, d),
  dropQueuedInRenderer: (convId, taskId) => send(Channels.mcpCancelQueued, { convId, taskId }),
  interruptInRenderer: (convId) => send(Channels.remoteInterrupt, { convId }),
  answerInRenderer: (convId, res) => send(Channels.remotePermissionResponse, { convId, res }),
  // A mesma lista do seletor da conversa (shared/selectableModels).
  models: {
    now: () => selectableModelIds({ ollama: ollamaSelectable(loadConfig().ollama), codex: isCodexConnected() }),
    fresh: async () => {
      await ensureConfigLoaded()
      return selectableModelIds({ ollama: ollamaSelectable(loadConfig().ollama), codex: (await codexStatus()).connected })
    }
  },
  log: (line) => console.log(line)
})

/**
 * Há conta Claude conectada? O login da máquina, ou (várias contas) qualquer
 * conta extra conectada — a conversa pode rodar noutra conta, então não se força
 * o login da conta 1 à toa. A resposta alimenta também o `GET /agent-code` do
 * MCP de entrada, que lê só a última leitura (o CLI leva segundos).
 */
async function refreshClaudeReady(): Promise<boolean> {
  const ready = (await isAuthenticated()) || (await extraClaudeAccountConnected())
  mcpInbound.setClaudeReady(ready)
  return ready
}

async function extraClaudeAccountConnected(): Promise<boolean> {
  await claudeAccounts.ensureLoaded()
  return (
    claudeAccounts.hasExtraAccounts() &&
    (await claudeAccounts.candidates()).some((account) => account.status === 'connected')
  )
}

// LAN bridge: phones POST commands here; we forward them to the renderer (which
// dispatches into the right conversation) and tee live agent events back over SSE.
// Identidade desta instalação perante o broker + o único celular pareado: por
// PC (userData), nunca na pasta de dados sincronizável.
const remotePairing = new RemotePairingStore(app.getPath('userData'))

const remote = new RemoteServer({
  onInbound: (convId, text, images, files, replyTo) => {
    // A mensagem do celular dá a volta pelo renderer (que a despacha na conversa
    // certa) e só então volta para cá no `agent:send`. Guardamos a marca aqui,
    // que é o único ponto que SABE que a origem é o celular.
    markRemoteInbound(convId, text)
    send(Channels.remoteInbound, { convId, text, images, files, ...(replyTo ? { replyTo } : {}) })
  },
  onInterrupt: (convId) => send(Channels.remoteInterrupt, { convId }),
  onSetMode: (convId, mode, on) => send(Channels.remoteSetMode, { convId, mode, on }),
  onConversationAction: (action) => send(Channels.remoteConversationAction, action),
  loadPairedDevice: () => remotePairing.pairedDevice(),
  savePairedDevice: (device) => remotePairing.setPairedDevice(device),
  onSetSkipPerms: (on) => send(Channels.remoteSetSkipPerms, { on }),
  onSetModel: (convId, model, effort) => send(Channels.remoteSetModel, { convId, model, effort }),
  onRecoveryAction: (convId, action) => send(Channels.remoteRecoveryAction, { convId, action }),
  onPermissionResponse: (convId, res) => send(Channels.remotePermissionResponse, { convId, res }),
  // "Para onde vai?" respondido no celular: o renderer (App → useCentral.choose) entrega.
  onCentralChoose: ({ entryId, option }) => send(Channels.remoteCentralChoose, { entryId, option }),
  apkPath: () => join(REMOTE_ROOT, 'dist', 'agent-remote.apk'),
  wwwDir: () => join(REMOTE_ROOT, 'www'),
  onClientsChanged: (info) => send(Channels.remoteClients, info),
  // Fixed pairing token, persisted in settings.json so phones stay paired.
  loadToken: () => loadConfig().remoteToken,
  saveToken: async (token) => {
    await updateConfig({ remoteToken: token })
  },
  // Voice runs on the PC with the local engines: the phone records/plays, we
  // transcribe (Parakeet) and synthesize (Kokoro, configured voice/speed).
  transcribe: (audioBase64, mimeType) => transcribeVoice(audioBase64, mimeType),
  tts: (text, opts) => speak(text, { treat: !opts?.treated }),
  ttsParts: (text) => speechParts(text)
})

// Outbound relay to the VPS broker: lets a phone reach this PC from ANY network
// (not just the LAN) without opening a port or sharing a VPS password — routing is
// by the bridge's own token. Dials out only while the bridge is ON.
const relay = new RelayClient({
  brokerUrl: REMOTE_RELAY_WS,
  getToken: () => remote.info().token,
  getInstanceId: () => remotePairing.instanceId(),
  getPort: () => remote.info().port,
  onStatus: (connected, state) => remote.setRelayConnected(connected, state),
  log: (line) => console.log(`[remote] ${line}`)
})

/** Get (creating if needed) the browser dedicated to a conversation. */
function getBrowser(convId: string): BrowserController {
  let b = browsers.get(convId)
  if (!b) {
    // Callbacks are gated on `activeConvId` so a background conversation's
    // browser never paints over the one the user is looking at.
    b = new BrowserController(
      {
        onFrame: (frame) => convId === activeConvId && send(Channels.browserFrame, frame),
        onState: (state) => convId === activeConvId && send(Channels.browserStateChanged, state),
        onPicked: (el) => convId === activeConvId && send(Channels.browserPicked, el),
        // Boot progress is tagged with convId so the renderer shows it on the right chat.
        onAndroidProgress: (line) => send(Channels.androidProgress, { convId, line })
      },
      convId
    )
    void b.setViewport(desiredViewport.width, desiredViewport.height)
    browsers.set(convId, b)
  }
  return b
}

/** The browser shown in the panel right now, if any (does not create one). */
function activeBrowser(): BrowserController | null {
  return activeConvId ? browsers.get(activeConvId) ?? null : null
}

function createWindow(startMinimized = false): void {
  if (closeRequestTimer) clearInterval(closeRequestTimer)
  closeRequestTimer = null
  closeRequested = false
  closeReady = false
  mainWindow = new BrowserWindow({
    // `--minimizado`: nasce escondida e aparece minimizada, sem pegar o foco.
    show: !startMinimized,
    width: 1500,
    height: 950,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#1f1e1d',
    title: 'Agent Code',
    icon: join(
      import.meta.dirname,
      '../../build',
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    ),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#262624',
      symbolColor: '#e8e6e3',
      height: 52
    },
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      // Enable Chromium's built-in PDF viewer so the file preview can render
      // PDFs in an <iframe>/<embed> (off by default).
      plugins: true
    }
  })

  if (startMinimized) {
    const win = mainWindow
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      // Mostra sem ativar e minimiza: fica na barra de tarefas, sem pegar o foco.
      // (minimize() numa janela escondida só marca o estado — ela não aparece.)
      win.showInactive()
      win.minimize()
    })
  }
  // Recarregou (F5) ou trocou de página: até o renderer avisar de novo que está
  // pronto, as tarefas do MCP de entrada esperam no main em vez de se perder.
  mainWindow.webContents.on('did-start-loading', () => mcpInbound.markRendererGone())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Mockup .html local: navegador padrão, mesmo com .html associado ao VS Code.
    void openUrlExternally(url)
    return { action: 'deny' }
  })
  // O app nunca navega para fora de si (F5 é reload, não navegação). Defesa em
  // profundidade do HTML do agente na TV (o iframe já é sandbox sem top-navigation).
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase()
    const reload = input.type === 'keyDown' && (key === 'f5' || (input.control && key === 'r'))
    if (!reload) return
    event.preventDefault()
    send(Channels.appReloadRequested, null)
  })

  // Grant microphone access for the voice dictation (getUserMedia). Electron denies
  // media by default with no handler; we allow only 'media' from our own renderer.
  // Both handlers are needed: the async request prompt AND the sync check that
  // getUserMedia consults first.
  const sess = mainWindow.webContents.session
  sess.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })
  sess.setPermissionCheckHandler((_wc, permission) => permission === 'media')

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void mainWindow.loadURL(devUrl)
  else {
    // Atribuição dos quadros longos no detector de travadas (file:// é origem opaca).
    const rendererIndex = join(import.meta.dirname, '../renderer/index.html')
    installJsProfilingPolicy(sess, rendererIndexMatcher(rendererIndex))
    void mainWindow.loadFile(rendererIndex)
  }

  mainWindow.on('close', (event) => {
    if (closeReady) return
    event.preventDefault()
    requestRendererCloseFlush()
  })

  mainWindow.on('closed', () => {
    // A janela escondida de captura não pode segurar o app aberto.
    officeMockup?.release()
    if (closeRequestTimer) clearInterval(closeRequestTimer)
    closeRequestTimer = null
    mainWindow = null
    closeRequested = false
    closeReady = false
  })
}

/**
 * Cronômetro de cada etapa da abertura, no mesmo arquivo de diagnóstico.
 * Com o banco autoritativo num PostgreSQL remoto, "o app demora a abrir" é uma
 * pergunta sobre QUAL etapa demorou — e sem isto não há como responder.
 */
function bootStage<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now()
  return run().then(
    (value) => {
      authLog(`boot ${name}: ${Date.now() - started}ms`)
      return value
    },
    (error: unknown) => {
      authLog(`boot ${name}: ${Date.now() - started}ms (falhou)`)
      throw error
    }
  )
}

// TEMP login diagnostics → logs/auth-debug.log in the local (non-synced) root
// (removed once the OAuth flow is confirmed end-to-end).
function authLog(line: string): void {
  try {
    const logsDir = join(getCacheInfo().localDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    appendFileSync(join(logsDir, 'auth-debug.log'), `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* best-effort */
  }
}

function logLeftoverRelocation({ moved, failed }: LeftoverRelocation): void {
  if (moved.length) console.log(`[storage] movido da pasta sincronizada para a local: ${moved.join(', ')}`)
  if (failed.length) console.warn(`[storage] ficou na pasta sincronizada (nova tentativa na próxima abertura): ${failed.join(', ')}`)
}

// Exportado só para main/index.test.ts invocar isoladamente sem passar por
// `app.whenReady()` (que dispara o boot inteiro do app).
export function registerIpc(): void {
  ipcMain.handle(Channels.storageStatusGet, () => storageLifecycle.status())
  ipcMain.handle(Channels.storagePostgresSettingsGet, () => storageLifecycle.postgresSettings())
  ipcMain.handle(Channels.storagePostgresTest, (_event, draft: PostgresConnectionDraft) =>
    storageLifecycle.testPostgres(draft)
  )
  ipcMain.handle(Channels.storagePostgresActivate, async (_event, draft: PostgresConnectionDraft) => {
    if (!(await confirmStorageTransitionStopsAgents('postgres'))) return false
    await storageLifecycle.activatePostgres(draft, storageTransitionHooks)
    relaunchAfterStorageTransition()
    return true
  })
  ipcMain.handle(Channels.storagePostgresDeactivate, async () => {
    if (!(await confirmStorageTransitionStopsAgents('sqlite'))) return false
    await storageLifecycle.deactivatePostgres(storageTransitionHooks)
    relaunchAfterStorageTransition()
    return true
  })
  ipcMain.handle(Channels.storageRetry, (_event, draft?: PostgresConnectionDraft) =>
    storageLifecycle.retryPostgres(draft)
  )
  ipcMain.handle(Channels.storagePostgresPasswordClear, () => storageLifecycle.clearPostgresPassword())
  ipcMain.handle(Channels.storageFlushReady, (_event, requestId: string, error?: string) => {
    const pending = pendingStorageFlushes.get(requestId)
    if (!pending) return
    pendingStorageFlushes.delete(requestId)
    clearTimeout(pending.timer)
    if (error) pending.reject(new Error(error))
    else pending.resolve()
  })
  ipcMain.handle(Channels.appGetVersion, () => app.getVersion())
  // Detector de travadas: lote do renderer, validado e gravado em fila (freezeLog.ts).
  ipcMain.handle(Channels.perfLogFreezes, (_e, batch: unknown) => logFreezes(batch))
  // App configuration (Settings screen).
  ipcMain.handle(Channels.configGet, async () => {
    storageLifecycle.repository()
    // Sem isto, uma chamada logo após o boot (a UI monta assim que o storage
    // fica pronto, mas a config em si só termina de carregar depois) via o
    // fallback local e devolvia interruptores "desligados" mesmo já ativados.
    await ensureConfigLoaded()
    return loadConfig()
  })
  // Modo sandbox e "Conectar conta" (lógica em sandbox.ts / providerStatus.ts).
  ipcMain.handle(Channels.sandboxInfo, () => ({ root: sandboxRoot() }))
  ipcMain.handle(Channels.sandboxCreate, () => sandboxCreateResult())
  const providersChanged = registerProviderStatusIpc({
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    send,
    channels: { status: Channels.providersStatus, changed: Channels.providersChanged },
    deps: {
      // Só desconexão comprovada (ou sessão expirada) desliga o Claude no card.
      claude: () => claudeConnectedForCard({ probe: () => claudeAuthProbe(), extraConnected: extraClaudeAccountConnected }),
      gpt: async () => (await codexStatus()).connected,
      ollama: () => ollamaSelectable(loadConfig().ollama)
    }
  })
  // Turno com erro de autenticação (ou o login/turno que o desfaz) reavalia o card.
  claudeAuthExpiry.onChange(providersChanged)
  ipcMain.handle(Channels.configSet, async (_e, patch: Partial<AppConfig>) => {
    assertStorageWritable()
    const result = await updateAppConfig(patch)
    if (patch && 'ollama' in patch) providersChanged()
    return result
  })
  ipcMain.handle(Channels.typesafeIsConfigured, () => typeSafeConfigured())
  ipcMain.handle(Channels.typesafePauseStatus, () => typeSafePause.status())
  // Aviso único ao ENTRAR na pausa; o renderer mostra o toast amarelo.
  typeSafePause.setOnPause((status) => send(Channels.typesafePaused, status))
  ipcMain.handle(Channels.appCloseReady, async () => {
    if (!closeRequested || !mainWindow) return
    if (closeRequestTimer) clearInterval(closeRequestTimer)
    closeRequestTimer = null
    if (quitRequested) await closeStorageForQuit()
    closeReady = true
    const windowToClose = mainWindow
    setImmediate(() => {
      windowToClose.close()
      if (quitRequested) {
        quitReady = true
        app.quit()
      }
    })
  })

  ipcMain.handle(Channels.appReloadReady, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.reload()
  })
  ipcMain.handle(Channels.windowsControlSetEnabled, async (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled deve ser booleano.')
    assertStorageWritable()
    await updateAppConfig({ windowsControlEnabled: enabled })
  })
  ipcMain.handle(Channels.chromeControlSetEnabled, async (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled deve ser booleano.')
    assertStorageWritable()
    await updateAppConfig({ chromeControlEnabled: enabled })
  })
  ipcMain.handle(Channels.chromeBridgeStatus, () => chromeBridgeStatus())
  ipcMain.handle(Channels.chromeExtensionInstall, () => openChromeInstall())

  // Chat voice (dictation + read-aloud) on this machine — see voiceService.ts.
  // Model downloads stream as speechSetupProgress to the asking window.
  registerVoiceIpc(ipcMain)
  // Settings: install each voice model / the Android toolchain ahead of time.
  registerVoiceComponentIpc(ipcMain)
  registerAndroidToolchainIpc(ipcMain)
  // Claude Code auth: status + the one-click OAuth login (no typed /login).
  ipcMain.handle(Channels.authStatus, async () => ({ authenticated: await refreshClaudeReady() }))
  ipcMain.handle(Channels.authLogin, async () => {
    authLog('=== auth:login start ===')
    // The FIRST login opens the user's own SYSTEM browser (product decision) — not
    // the app's embedded browser. The CLI runs a loopback to capture the code.
    const openUrl = (url: string): void => {
      authLog(`opening system browser: ${url}`)
      void shell.openExternal(url)
    }
    const ok = await runClaudeLogin(openUrl, authLog)
    authLog(`=== auth:login done: authenticated=${ok} ===`)
    if (ok) claudeAuthExpiry.clear()
    providersChanged()
    return { ok }
  })
  // Observadores (Vigia, Memorista, PO, título, curador) rodam na conta Claude
  // da conversa que acompanham.
  setClaudeObserverEnvResolver((convId, model) => observerEnvFor(convId, model))
  // Contas Claude: o login de cada conta usa o mesmo navegador do sistema.
  configureAccountLogin({
    openUrl: (url) => {
      authLog(`opening system browser (account): ${url}`)
      void shell.openExternal(url)
    },
    log: authLog,
    onLogin: providersChanged
  })
  registerClaudeAccountsIpc({
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    registry: claudeAccounts,
    usage: async (force, accountId) =>
      accountId ? [await queryAccountUsage(accountId, { force })] : queryAllAccountsUsage({ force }),
    // A conversa da conta removida volta à regra de conversa nova no próximo início.
    onRemoved: (id) => {
      for (const convId of sessions.keys()) if (conversationAccount(convId) === id) forgetConversationAccount(convId)
    },
    useForConversation: (convId, accountId, continueTask) =>
      sessions.get(convId)?.useAccount(accountId, continueTask) ?? null
  })
  ipcMain.handle(Channels.authLogout, async () => {
    assertStorageWritable()
    const status = await logoutClaude()
    authLog(`=== auth:logout: loggedIn=${status.loggedIn} authMethod=${status.authMethod} ===`)
    providersChanged()
    return status
  })

  // OpenAI Codex auth: same one-click OAuth pattern as Claude above, but
  // against the ChatGPT subscription login instead of an Anthropic account.
  ipcMain.handle(Channels.codexStatus, () => codexStatus())
  ipcMain.handle(Channels.codexLogin, async () => {
    assertStorageWritable()
    authLog('=== codex:login start ===')
    const openUrl = (url: string): void => {
      authLog(`opening system browser: ${url}`)
      void shell.openExternal(url)
    }
    const result = await runCodexLogin(openUrl, authLog)
    authLog(`=== codex:login done: ok=${result.ok} message=${result.message ?? ''} ===`)
    providersChanged()
    return result
  })
  ipcMain.handle(Channels.codexLogout, async () => {
    assertStorageWritable()
    await codexLogout()
    authLog('=== codex:logout ===')
    providersChanged()
  })

  // Cache folder: where the SQLite db (config/token/conversations) + .md memories live.
  ipcMain.handle(Channels.cacheGetInfo, () => getCacheInfo())
  ipcMain.handle(Channels.cacheChooseDir, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Escolha onde salvar os dados do Agent Code',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    assertStorageWritable()
    await storageTransitionHooks.waitForIdleAgents()
    await requestStorageFlush()
    const info = setCacheDir(res.filePaths[0])
    if (storageLifecycle.status().backend === 'sqlite') {
      await storageLifecycle.initializeSqlite(info)
      // Reload, não init: a init já carregada devolvia o snapshot da pasta antiga.
      await reloadConfigPersistence()
      await initializeCodexAuthPersistence()
    } else {
      storageLifecycle.updateSqliteLocation(info)
    }
    const skillSync = syncCacheSkills(app.getAppPath(), info.dir)
    for (const error of skillSync.errors) console.error(`[skills] ${error}`)
    void relocateLocalLeftovers(info.dir, info.localDir).then(logLeftoverRelocation)
    const enabled = loadConfig().windowsControlEnabled === true
    windowsControl.setEnabled(enabled)
    send(Channels.windowsControlChanged, enabled)
    return info
  })
  // Names and dates only. The value never crosses to the renderer: the model
  // gets it through the vault tool, the settings screen never displays it.
  ipcMain.handle(Channels.secretVaultList, async (): Promise<SecretVaultItem[]> =>
    (await listSecretMetadata()).map((item) => ({
      name: item.name,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }))
  )
  ipcMain.handle(Channels.secretVaultDelete, (_e, name: string) => deleteSecret(name))
  ipcMain.handle(Channels.memoryConflicts, async (): Promise<MemoryConflictItem[]> => {
    const service = memoryService()
    if (!service) return []
    const proposals = await service.listProposals({ status: ['conflict', 'rejected'], limit: 200 })
    return proposals.map((item) => ({
      id: item.id,
      op: item.op,
      relPath: item.relPath,
      status: item.status as 'conflict' | 'rejected',
      reason: item.reason,
      proposedBy: item.proposedBy,
      updatedAt: item.updatedAt
    }))
  })
  // O painel de Memórias do Escritório: só leitura (memoryReadIpc.ts).
  registerMemoryReadIpc({ handle: (channel, handler) => ipcMain.handle(channel, handler), entries: () => memoryService()?.listEntries() ?? null })
  ipcMain.handle(Channels.memoryDiscardProposal, async (_e, id: string) => {
    const service = memoryService()
    if (!service) throw new StorageError('STORAGE_OFFLINE', 'Persistência autoritativa offline.', true)
    return service.discardProposal(id)
  })
  // Read-only window onto the task ledger. It degrades instead of throwing:
  // the panel is an observation surface, and a storage hiccup must not become
  // an error dialog on top of the chat.
  ipcMain.handle(Channels.tasksBoard, async (_e, query?: TaskBoardQuery) => {
    try {
      return await buildTaskBoard(taskLedger(), query)
    } catch {
      return { available: false, items: [] }
    }
  })
  ipcMain.handle(
    Channels.boardList,
    async (_e, query: { projectCwd: string; conversationId?: string; includeDismissed?: boolean }) => {
      // Sem repositório gravável o quadro não é "vazio", é indisponível — e a
      // tela precisa dessa diferença para explicar em vez de mentir.
      if (!storageLifecycle.canMutate()) return { available: false, items: [] }
      try {
        const items = await board.list(query?.projectCwd ?? '', {
          conversationId: query?.conversationId,
          includeDismissed: query?.includeDismissed
        })
        // `null` = não deu para ler (pasta do projeto fora do ar). Devolver
        // lista vazia aqui faria a tela dizer "nenhuma tarefa ainda" sobre um
        // quadro que pode estar cheio.
        return items === null ? { available: false, items: [] } : { available: true, items }
      } catch {
        return { available: false, items: [] }
      }
    }
  )
  ipcMain.handle(Channels.boardDismiss, async (_e, id: string, dismissed: boolean) => {
    try {
      return await board.dismiss(id, dismissed)
    } catch {
      return null
    }
  })
  ipcMain.handle(Channels.boardMove, async (_e, id: string, toStatus: BoardItemStatus) => {
    try {
      return await board.move(id, toStatus)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Não foi possível mover o cartão.' }
    }
  })
  ipcMain.handle(Channels.boardItemEvents, async (_e, boardItemId: string) => {
    try {
      return await board.listItemEvents(boardItemId)
    } catch {
      return []
    }
  })
  // Tela de Planejamento: toda a lógica (validação, vigia, erros) mora em planningIpc.
  planningIpc = registerPlanningIpc({ handle: (channel, listener) => ipcMain.handle(channel, listener), send })
  // Envios de handoff no banco: o mesmo getter e a mesma identidade de projeto do Quadro.
  registerHandoffIpc({
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    repository: () => (storageLifecycle.canMutate() ? storageLifecycle.repository() : null),
    projectId: (cwd) => board.projectId(cwd),
    tracker: handoffTracker
  })
  ipcMain.handle(Channels.planningExportPdf, (e, req: unknown) => exportFlowPdf(e.sender, req))
  // Título automático da conversa (claude-haiku-4-5): a lógica mora em titles/.
  registerConversationTitleIpc({ handle: (channel, listener) => ipcMain.handle(channel, listener) })
  // Fila de espera das conversas, gravada no banco para sobreviver ao reinício.
  registerOutboxIpc({
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    repository: () => (storageLifecycle.canMutate() ? storageLifecycle.repository() : null)
  })
  // Central: decisor de destino (TypeSafe) e log de correções; a lógica mora em central/.
  centralIpc = registerCentralIpc({
    handle: (channel, listener) => ipcMain.handle(channel, listener),
    load: async (query) => storageLifecycle.repository().loadConversations(query),
    subscribe: (handler) => storageLifecycle.subscribeChanges(handler),
    sandboxRoot,
    isSandbox: isSandboxPath,
    correctionsFile: () => join(getCacheInfo().localDir, 'central', 'corrections.jsonl')
  })
  ipcMain.handle(Channels.tasksDetail, async (_e, taskId: string) => {
    try {
      return await buildTaskDetail(taskLedger(), taskId)
    } catch {
      return null
    }
  })
  // Histórico do contexto entregue ao agente e o olho das senhas: só IPC do PC,
  // nunca a ponte do celular.
  registerContextIpc({
    handle: (channel, handler) => ipcMain.handle(channel, handler),
    repository: () => storageLifecycle.repository(),
    reveal: readSecretForReveal
  })
  // Chamadas e totais persistidos de uma conversa (`llm_calls`/`llm_usage_totals`),
  // para reconstruir a árvore de consumo de tokens ao reabrir uma conversa antiga.
  ipcMain.handle(Channels.tokenUsageHistory, async (_e, convId: string): Promise<TokenUsageHistory> => {
    const repository = storageLifecycle.repository()
    const [calls, totals] = await Promise.all([
      repository.listLlmCalls(convId),
      repository.listLlmUsageTotals(convId)
    ])
    return { calls, totals }
  })
  ipcMain.handle(Channels.kvGet, (_e, key: string) => readPersistedKv(key))
  ipcMain.handle(Channels.kvSet, (_e, key: string, value: string) => {
    assertStorageWritable(true)
    return writePersistedKv(key, value)
  })
  ipcMain.handle(Channels.conversationsLoadAll, async () =>
    (await storageLifecycle.repository().loadConversations()).map((entry) => entry.payload)
  )
  // No query = the legacy "everything, tombstones included" read. A query narrows it
  // (first page per project, one project, or specific ids for the change feed).
  ipcMain.handle(Channels.conversationsLoadVersioned, (_e, query?: ConversationQueryDto) =>
    storageLifecycle.repository().loadConversations(query ? { includeDeleted: true, ...query } : { includeDeleted: true })
  )
  ipcMain.handle(Channels.conversationsCountByProject, () =>
    storageLifecycle.repository().countConversationsByProject()
  )
  ipcMain.handle(Channels.conversationsUpsert, async (_e, input: ConversationUpsertDto) => {
    if (!input || typeof input.id !== 'string' || !input.id || !input.payload || typeof input.payload !== 'object') {
      throw new TypeError('Conversa inválida.')
    }
    assertStorageWritable(true)
    const held = sessionLeases.get(input.id)
    let payload: ConversationRecord
    try {
      payload = await attachProjectIdentity(input.payload)
    } catch (cause) {
      if (!isMissingProjectFolderError(cause)) throw cause
      const persisted = (await storageLifecycle.repository().loadConversations({ includeDeleted: true }))
        .find((entry) => entry.id === input.id)?.payload
      payload = preserveProjectIdentityForMissingPersistedWrite(input.payload, persisted)
    }
    try {
      // Resolvedor, não a instância: a repetição depois da renovação vai para o
      // repositório ativo de então (uma reconexão pode trocá-lo no meio).
      return await upsertConversationWithLeaseRecovery(
        () => storageLifecycle.repository(),
        {
          ...input,
          payload,
          ...(held ? { lease: { token: held.lease.token, fencingEpoch: held.lease.fencingEpoch } } : {})
        },
        // Lease vencido na queda e ainda não renovado pelo heartbeat: renova já e
        // repete, só se continua sendo desta instalação (ver conversationWriteRecovery).
        held ? sessionLeaseRenewal(held, () => sessionLeases.get(input.id) === held) : undefined
      )
    } catch (cause) {
      throw storageErrorForIpc(cause)
    }
  })
  ipcMain.handle(Channels.conversationsDelete, async (_e, input: ConversationDeleteDto) => {
    if (!input || typeof input.id !== 'string' || !Number.isInteger(input.expectedRevision)) {
      throw new TypeError('Exclusão de conversa inválida.')
    }
    assertStorageWritable(true)
    const held = sessionLeases.get(input.id)
    try {
      return await deleteConversationWithLeaseRecovery(
        () => storageLifecycle.repository(),
        { ...input, ...(held ? { lease: { token: held.lease.token, fencingEpoch: held.lease.fencingEpoch } } : {}) },
        held ? sessionLeaseRenewal(held, () => sessionLeases.get(input.id) === held) : undefined
      )
    } catch (cause) {
      throw storageErrorForIpc(cause)
    }
  })
  ipcMain.handle(Channels.conversationsSaveAll, async (_e, list: unknown) => {
    // A malformed (non-array) payload must never be treated as "zero conversations" —
    // that would delete every conversation, not just skip the save.
    if (!Array.isArray(list)) return
    assertStorageWritable()
    await storageLifecycle.repository().replaceAllConversations(list as ConversationRecord[])
  })

  ipcMain.handle(Channels.pickDirectory, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle(Channels.pickFile, async () => {
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // Project-folder guard: true only when the path exists and is a directory.
  ipcMain.handle(Channels.pathExists, async (_e, p: string) => {
    try {
      const s = await fsStat(p)
      return s.isDirectory()
    } catch {
      return false
    }
  })

  // Open a project folder in VS Code. First try the `code` CLI (handles folders
  // properly); if it isn't on PATH, fall back to VS Code's `vscode://` URL handler
  // (registered by the installer). Returns a status so the renderer can toast.
  ipcMain.handle(Channels.openInEditor, async (_e, dir: string): Promise<{ ok: boolean; message: string }> => {
    if (!dir) return { ok: false, message: 'Nenhuma pasta para abrir.' }
    const launched = await new Promise<boolean>((resolve) => {
      // shell:true so Windows resolves `code` → `code.cmd` via PATHEXT.
      const child = spawn(`code "${dir}"`, { shell: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
    if (launched) return { ok: true, message: 'Abrindo no VS Code…' }
    try {
      await shell.openExternal('vscode://file/' + dir.replace(/\\/g, '/'))
      return { ok: true, message: 'Abrindo no VS Code…' }
    } catch {
      return {
        ok: false,
        message: 'Não foi possível abrir o VS Code. Verifique se está instalado e se o comando "code" está no PATH.'
      }
    }
  })

  ipcMain.handle(Channels.openInFolder, async (_e, dir: string): Promise<{ ok: boolean; message: string }> => {
    if (!dir) return { ok: false, message: 'Nenhuma pasta para abrir.' }
    // shell.openPath opens the folder itself in the OS file explorer; it resolves
    // with an empty string on success or an error description on failure.
    const err = await shell.openPath(dir)
    return err
      ? { ok: false, message: `Não foi possível abrir a pasta: ${err}` }
      : { ok: true, message: 'Abrindo a pasta no explorador…' }
  })

  ipcMain.handle(
    Channels.mentionSearch,
    async (_e, root: string, query: string): Promise<MentionHit[]> => {
      if (!root) return []
      return searchProjectEntries(root, query)
    }
  )

  ipcMain.handle(Channels.listSkills, async (_e, root: string): Promise<SkillInfo[]> => {
    return listAgentSkills(root)
  })

  ipcMain.handle(
    Channels.projectTree,
    async (_e, root: string, keep: string[] = []): Promise<ProjectTree> => {
      if (!root) return { nodes: [], truncated: false, missing: [] }
      return readProjectTree(root, keep)
    }
  )

  ipcMain.handle(Channels.projectDir, (_e, root: unknown, rel: unknown): Promise<ProjectDirListing> => listProjectDir(root, rel))

  // Sidebar: the project's own icon, if the folder happens to have one. Null is
  // the normal answer (the sidebar keeps the folder glyph), never an error.
  ipcMain.handle(Channels.projectIcon, async (_e, root: string): Promise<string | null> => {
    try {
      return await readProjectIcon(root)
    } catch {
      return null
    }
  })

  // Save a copy of a file the agent created into the user's Downloads folder and
  // reveal it (so "baixar" works on the desktop too, not only on the phone).
  ipcMain.handle(
    Channels.fileDownload,
    async (_e, path: string): Promise<{ ok: boolean; message: string; saved?: string }> => {
      if (!path) return { ok: false, message: 'Caminho de arquivo ausente.' }
      // Same rule the phone bridge applies: only a file the agent actually
      // offered (a `Write` deliverable or a `[[download:]]` marker) can be
      // copied out. Without this the channel would copy any path it is handed.
      const allowed = await downloadAllowlist.allows(path, async () => {
        const conversations = await storageLifecycle.repository().loadConversations()
        return conversations.map((c) => {
          const messages = (c.payload as Record<string, unknown>).messages
          return Array.isArray(messages) ? messages : []
        })
      })
      if (!allowed) {
        return { ok: false, message: 'Esse arquivo não foi disponibilizado para download pelo agente.' }
      }
      try {
        const src = await fsStat(path)
        if (!src.isFile()) return { ok: false, message: 'O caminho não é um arquivo.' }
        const downloads = app.getPath('downloads')
        let dest = join(downloads, basename(path))
        // Avoid clobbering an existing file: append " (1)", " (2)", …
        const ext = extname(dest)
        const stem = dest.slice(0, dest.length - ext.length)
        let n = 1
        while (await fsExists(dest)) dest = `${stem} (${n++})${ext}`
        await fsCopyFile(path, dest)
        shell.showItemInFolder(dest)
        return { ok: true, message: `Salvo em ${dest}`, saved: dest }
      } catch (err) {
        return { ok: false, message: `Falha ao baixar: ${String(err)}` }
      }
    }
  )

  ipcMain.handle(Channels.fileRead, async (_e, absolutePath: string) => {
    try {
      return await fsReadFile(absolutePath, 'utf8')
    } catch (err) {
      return `Erro ao ler arquivo: ${String(err)}`
    }
  })

  // Read a file as raw bytes (base64) for binary previews (PDF, images, xlsx…).
  // Capped at 50 MB so a huge file can't blow up the IPC payload / renderer memory.
  ipcMain.handle(Channels.fileReadBytes, async (_e, absolutePath: string): Promise<FileBytes> => {
    try {
      const buf = await fsReadFile(absolutePath)
      if (buf.byteLength > 50 * 1024 * 1024) {
        return { ok: false, error: 'Arquivo muito grande para visualizar (limite de 50 MB).' }
      }
      return { ok: true, base64: buf.toString('base64'), size: buf.byteLength }
    } catch (err) {
      return { ok: false, error: `Erro ao ler arquivo: ${String(err)}` }
    }
  })

  // Composer: a pasted line that looks like a local path — stat only, no
  // bytes read, so the agent opens the ORIGINAL path with its own tools.
  ipcMain.handle(Channels.resolvePastedPath, async (_e, rawPath: string): Promise<ResolvedPastedRef> => {
    return resolvePastedPath(rawPath)
  })

  // Composer: a pasted line that looks like a file URL — download it to disk
  // (streaming) and hand back the saved path, never the bytes.
  ipcMain.handle(
    Channels.downloadPastedUrl,
    async (_e, url: string, convId: string): Promise<ResolvedPastedRef> => {
      return downloadPastedUrl(url, convId)
    }
  )

  // Composer: anexo de um rascunho vai para o disco; o rascunho guarda o caminho.
  ipcMain.handle(Channels.stashDraftAttachment, (_e, convId: unknown, file: unknown) => stashDraftAttachment(convId, file))
  ipcMain.handle(Channels.discardDraftAttachments, (_e, convId: unknown, paths: unknown) => discardDraftAttachments(convId, paths))
  ipcMain.handle(Channels.promoteDraftAttachments, (_e, convId: unknown, paths: unknown) => promoteDraftAttachments(convId, paths))

  /**
   * O modo Automático, resolvido AQUI e não no renderer.
   *
   * A sessão do SDK fixa o modelo pela vida dela, então a escolha do turno tem
   * de acontecer antes de a sessão existir — e este handler é o único ponto que
   * tem ao mesmo tempo a mensagem que vai ser enviada e o poder de criar a
   * sessão. A decisão em si mora em `typesafe/execution.ts` (testável sem
   * Electron); aqui fica só o IO dela.
   */
  const autoStart = async (opts: StartAgentOptions): Promise<AutoStartDecision> => {
    // Os candidatos são a MESMA lista que o seletor manual oferece agora: Claude
    // sempre, e os GPT só com login do ChatGPT no ar. A checagem mora aqui, e não
    // em `typesafe/execution.ts`, para aquela camada continuar pura (testável sem
    // Electron nem IO). Sem login, `models` fica ausente e vale o padrão de lá.
    //
    // `codexStatus()` e não `isCodexConnected()`: a versão assíncrona espera a
    // carga dos tokens em vez de ler "deslogado" de uma carga que ainda não
    // terminou — a primeira mensagem logo após abrir o app cairia nisso.
    const candidates = (await codexStatus()).connected
      ? [...CLAUDE_MODELS, ...OPENAI_MODELS].map((model) => model.id)
      : undefined
    // O usuário pode restringir ainda mais essa lista nas configurações do
    // TypeSafe (Geral → seção do Automático). Vazio = sem restrição — o
    // filtro só entra quando há algo marcado, e nunca esvazia a lista por
    // completo (um subconjunto vazio por engano não pode travar o envio).
    const allowed = loadConfig().typesafe.allowedAutoModels
    const models =
      allowed.length > 0
        ? (candidates ?? autoModelCandidates()).filter((model) => allowed.includes(model))
        : candidates
    const decision = await resolveAutoStart(
      {
        autoPrompt: opts.autoPrompt,
        live: autoSessions.get(opts.convId),
        hasSession: sessions.has(opts.convId)
      },
      // Teto de 3 s: é o caminho que segura o envio. Passou, sai o par padrão.
      // `selection`: só a dimensão em Automático é perguntada; a fixa é a do
      // usuário (o esforço fixo recortado ao modelo que sair).
      {
        ...(models && models.length > 0 ? { models } : {}),
        selection: { model: opts.model ?? AUTO_MODEL, effort: opts.effort },
        timeout: TYPESAFE_BLOCKING_TIMEOUT_MS
      }
    )
    // A escolha é anunciada em TODO turno, inclusive quando repete o par
    // anterior: o que o usuário precisa saber é COM QUE modelo a mensagem dele
    // saiu, não se isso mudou desde a última. Vai como `provider-switch`, que o
    // chat e o cliente do celular já renderizam como nota de sistema.
    //
    // Sem nota não há o que anunciar — um religar sem turno não escolheu nada.
    // `fromModel: AUTO_MODEL` marca o evento como ANÚNCIO do Automático (e não
    // troca de provedor): o renderer não sobrescreve com ele o modelo nem o
    // esforço gravados na conversa, que continuam sendo os sentinels.
    if (decision.note) {
      const event: ChatEvent = {
        kind: 'provider-switch',
        id: randomUUID(),
        fromModel: AUTO_MODEL,
        model: decision.execution.model,
        effort: decision.execution.effort,
        fastMode: false,
        text: decision.note
      }
      send(Channels.agentEvent, { convId: opts.convId, event })
      remote.broadcast(opts.convId, event)
    }
    return decision
  }

  // Função nomeada (e não só o handler do IPC): o `agent:send` a chama também,
  // para refazer a sessão de uma tarefa MCP que pede outro modelo. Nesse caso
  // (`keepPrevious`) a sessão antiga só é descartada DEPOIS que a nova subiu: se
  // a nova falhar, a antiga continua a da conversa, com o lease dela.
  //
  // Quem chama SEMPRE está dentro do `sessionLock` da conversa (o handler do
  // agent:start e a troca do agent:send): duas subidas da mesma conversa nunca
  // se cruzam, então nunca ficam duas sessões vivas nem uma substituída sem dispose.
  // O lock NÃO tem prazo e nada nele é abandonado: quem tem prazo é cada passo
  // que pode travar (sessionSteps.ts — lease, retomada). Um passo que estoura
  // falha a subida, e ela desfaz o que criou (lease, sessão) antes de sair do lock.
  const sessionLock = createConversationLock()
  // "Continuar na conta X" no turno de uma tarefa MCP que terminou em erro: a
  // mesma recusa da retomada automática (regra 2) — o app não continua tarefa.
  const withContinueRefusal = (convId: string, deps: AccountSwitchDeps | undefined): AccountSwitchDeps | undefined =>
    deps && {
      ...deps,
      continueRefused: () => (mcpInbound.refusal(convId, { text: '', kind: 'recovery' }) ? MCP_NO_CONTINUE_WARNING : null)
    }
  const startAgentSession = async (
    opts: StartAgentOptions,
    { keepPrevious = false }: { keepPrevious?: boolean } = {}
  ) => {
    assertStorageWritable()
    const { convId } = opts
    // A sessão que a troca (`keepPrevious`) vai substituir, lida ANTES de qualquer
    // `await`. Com o lock, só o descarte da conversa (agent:dispose) pode tirá-la
    // do mapa no meio — conferido no fim.
    const previous = keepPrevious ? sessions.get(convId) : undefined
    const project = await fsStat(opts.cwd).catch(() => null)
    if (!project?.isDirectory()) throw new Error('A pasta local do projeto não foi localizada nesta instalação.')
    // Conversa de tarefa MCP: servidores do chamador, "Permitir tudo" e o modelo
    // fixo, do registro do main. O `inboundMcp` do renderer nunca passa daqui.
    opts = mcpInbound.sessionOptions(opts)
    // Agent Manager: modelo e esforço vêm da configuração do planejamento e saem
    // concretos — o Automático da conversa (logo abaixo) não roda para ele.
    opts = await planningStartOptions(opts, { config: () => loadConfig().planning })
    // Sessão viva com trabalho em background (subagente, shell, loop agendado):
    // trocá-la mataria esse trabalho em silêncio — o SDK fecha o stdin do processo
    // antigo e o mata segundos depois, com tudo o que rodava nele. Então ela fica:
    // a mensagem sai no modelo/esforço dela e o Automático nem é consultado (a
    // nota dele anunciaria um par que não vai rodar). Mesmo padrão da troca de
    // conta (providerFailover.ts, `tryPending`). A troca da tarefa MCP
    // (`previous`) não passa por aqui, nem o descarte explícito (Parar sessão,
    // agent:dispose). Sessão morta não segura nada: segue o caminho de sempre.
    const kept = previous ? undefined : sessions.get(convId)
    if (kept?.isAlive() && kept.hasBackgroundWork()) {
      const live = kept.liveOptions()
      // Pasta e config MCP trocadas não podem sumir caladas: ficam registradas e avisadas.
      const cwdChanged = opts.cwd !== live.cwd
      const mcpChanged = JSON.stringify(opts.inboundMcp ?? null) !== JSON.stringify(live.inboundMcp ?? null)
      logSession('session-kept', {
        convId, reason: 'background', background: true, model: live.model, effort: live.effort, cwdChanged, mcpChanged
      })
      const changed =
        (!isAutoModel(opts.model) && opts.model !== live.model) || (!isAutoEffort(opts.effort) && opts.effort !== live.effort)
      if (changed || cwdChanged || mcpChanged || opts.autoPrompt?.message.trim()) {
        const deferred = [cwdChanged ? 'de pasta' : '', mcpChanged ? 'da configuração MCP' : ''].filter(Boolean).join(' e ')
        const event: ChatEvent = {
          kind: 'status',
          id: randomUUID(),
          text: `Há trabalho em background rodando nesta conversa: mantive a sessão atual (${live.model ?? 'modelo padrão'}${live.effort ? `, esforço ${live.effort}` : ''}) para não interrompê-lo.` +
            (deferred ? ` A troca ${deferred} fica para quando o background terminar (vale na próxima sessão desta conversa).` : '')
        }
        send(Channels.agentEvent, { convId, event })
        remote.broadcast(convId, event)
      }
      return { ok: true, claudeAccountId: storableSessionAccount(convId, conversationAccount(convId)) }
    }
    // O estado por conversa (Manager, origem do Automático, pasta) é da sessão
    // que sobe. Numa troca (`previous`), só é gravado depois que a nova subiu e
    // assumiu: se ela falhar ou perder a vez, a antiga continua com o dela.
    const planningRef = { convId, planning: opts.planning }
    let autoLive: AutoStartDecision['live'] | undefined
    // Houve turno no Automático e o par dele não reaproveitou a sessão viva (o
    // motivo da troca no log de sessões).
    let autoTurn = false
    const commitState = (cwd: string): void => {
      planningConversations.track(planningRef)
      if (autoLive) autoSessions.set(convId, autoLive)
      else autoSessions.delete(convId)
      sessionCwds.set(convId, cwd)
    }
    if (isAutoModel(opts.model) || isAutoEffort(opts.effort)) {
      const auto = await autoStart(opts)
      autoLive = auto.live
      autoTurn = !!opts.autoPrompt?.message.trim() && !auto.reuse
      // Reaproveitar só quando a sessão viva JÁ é o que este start pede: nunca
      // numa troca (`previous`: ela existe justamente porque a viva não serve),
      // e só se a viva está no modelo decidido e com a mesma config MCP (uma
      // sessão aberta antes da config MCP, ou num modelo trocado por cota, não
      // serve para a tarefa só porque o par do Automático repetiu).
      // Sessão cuja query já morreu nunca serve: cada envio falharia e a recuperação
      // gastaria as tentativas nela. Cai no caminho abaixo, que descarta `replaced`
      // (fora do mapa + dispose) e sobe outra.
      const liveSession = sessions.get(convId)
      const live = liveSession?.liveOptions()
      const reuse =
        auto.reuse &&
        !previous &&
        !!live &&
        !!liveSession?.isAlive() &&
        (!opts.inboundMcp && !live.inboundMcp
          ? true
          : !!opts.inboundMcp && !!live.inboundMcp && live.model === auto.execution.model)
      if (reuse) {
        // Guardado ANTES de voltar: mesmo com o par repetindo, a origem dele pode
        // ter mudado (o fallback do turno anterior virou decisão agora), e é a
        // origem que manda no turno seguinte.
        commitState(opts.cwd)
        return { ok: true, claudeAccountId: storableSessionAccount(convId, conversationAccount(convId)) }
      }
      // Os sentinels `auto` (modelo e esforço) NUNCA chegam ao provedor: daqui
      // para baixo a sessão é montada no par concreto que a decisão devolveu
      // (esforço ausente = modelo sem esforço). O parâmetro é reatribuído
      // de propósito — todo o resto do handler já lê deste objeto, e duplicá-lo
      // num segundo nome abriria espaço para um caminho continuar no sentinel.
      opts = { ...opts, model: auto.execution.model, effort: auto.execution.effort }
    }
    if (!previous) commitState(opts.cwd)
    // Conta Claude da conversa: a gravada (se ainda conectada) ou a regra de
    // conversa nova, pela última leitura guardada — sem consultar, para não
    // atrasar o primeiro envio. Os observadores seguem a mesma conta.
    const claudeAccountId = await resolveSessionAccount(convId, opts.claudeAccountId, opts.model)
    opts = { ...opts, claudeAccountId }
    // Replace only THIS conversation's session; others keep running.
    const replaced = previous ? undefined : sessions.get(convId)
    if (!previous) {
      if (replaced) {
        // Descartada = fora do mapa NA HORA, antes de qualquer `await`: nenhum
        // agent:send nem "agora" envia para uma sessão descartada enquanto esta
        // subida espera o lease ou a retomada. O turno de tarefa MCP que estava
        // aberto nela se perdeu: termina em erro já, não quando (e se) a nova subir.
        const was = replaced.liveOptions()
        logSession('session-replaced', {
          convId, reason: !replaced.isAlive() ? 'dead' : autoTurn ? 'auto-pair' : 'config',
          background: replaced.hasBackgroundWork(), model: was.model, effort: was.effort
        })
        sessions.delete(convId)
        replaced.dispose()
        // O dispose não emite `result`/`error`: o turno aberto nela acabou aqui.
        handoffTracker.sessionEnded(convId)
        mcpInbound.onSessionInstalled(convId)
      }
      await releaseSessionLease(convId)
    }
    // Aquisição com prazo próprio (sessionLeases.ts): estourou, nada foi
    // instalado e o lease que chegar tarde é solto — não há o que desfazer aqui.
    const repository =
      previous && sessionLeases.has(convId) ? storageLifecycle.repository() : (await acquireSessionLease(convId)).repository
    // A sessão sobrevive a uma reconexão automática (o repositório da aquisição é
    // fechado por setOffline): tudo o que ela usa durante a vida resolve o
    // repositório ATIVO a cada chamada, como o keeper do lease (activeRepository.ts).
    const activeRepository = (): PersistenceRepository => storageLifecycle.repository()
    const sessionStore = activeSessionStore(activeRepository, convId)
    const resumeMarker = activeResumeMarker(activeRepository)
    try {
      // Prazo total (RESUME_PREPARE_DEADLINE_MS): estourou, falha com erro claro
      // — nunca sobe sem retomar em silêncio — e o lease que esta subida pegou é
      // solto antes de sair do lock.
      if (opts.resume) await prepareSessionResumeWithin(repository, convId, opts.cwd, opts.resume)
    } catch (error) {
      if (!previous) await releaseSessionLease(convId)
      throw error
    }
    let s!: ProviderFailoverSession
    // Conversa de handoff: o acompanhamento dos envios passa a olhá-la.
    if (opts.handoff) handoffTracker.attach(convId, opts.cwd)
    const emit = (event: ChatEvent): void => {
      send(Channels.agentEvent, { convId, event })
      // Todo terminal de erro da conversa (AgentSession e failover passam por aqui).
      if (event.kind === 'error') {
        logSession('turn-error', {
          convId, incomplete: event.incomplete === true, retryable: event.retryable,
          usageExhausted: event.usageExhausted, turnIds: event.turnIds
        })
      }
      // Antes do `return` abaixo: o acompanhamento precisa do `turn-start`.
      if (opts.handoff) handoffTracker.observe(convId, opts.cwd, event)
      // Código ao vivo do monitor do escritório: efêmero e só da tela local. Para
      // aqui, num ponto só: não vai ao celular, não autoriza download, não fecha
      // tarefa MCP e nenhum observador (vigia, quadro, PO, memorista) o vê — até
      // 10 por segundo por bloco seria só custo para todos eles. O `turn-start`
      // (identidade de turno) também é só da tela local: estado, não conteúdo.
      if (event.kind === 'tool-input-delta' || event.kind === 'turn-start') return
      remote.broadcast(convId, event)
      // Fim de turno de uma tarefa MCP (resposta, erro) sai daqui.
      mcpInbound.onEvent(convId, event)
      // O consumo lido pela sessão vira a última leitura da conta dela.
      if (event.kind === 'rate-limit') recordSessionRateLimit(convId, event.limits)
      // Recorded here, not inside the bridge: the desktop download must be
      // authorized whether or not the phone bridge is running.
      downloadAllowlist.track(event)
      // Daqui para baixo só observadores (vigia, quadro, PO, memorista), e a
      // conversa do Agent Manager não alimenta nenhum deles.
      if (!planningConversations.observed(convId)) return
      // O vigia lê o mesmo tee — e a saída dele NÃO volta por aqui: alerta é
      // para o usuário, não para o modelo (canal próprio, ver vigia.ts).
      vigia.observe(convId, event)
      // O quadro se alimenta do MESMO tee: do snapshot autoritativo
      // (`task-list`) — nunca dos eventos incrementais, que congelam o quadro
      // quando o app perde um deles — e do fim do turno (`result`/`error`), que
      // é quando o que ficou "fazendo" volta para "a fazer" (ver boardService.ts).
      board.observe(convId, opts.cwd, event)
      // O PO lê o mesmo tee e fecha o turno com a auditoria — é lá que dá para
      // ver o que terminou de verdade (a abertura entra pelo `noteUserMessage`).
      //
      // O fechamento que o `board.observe` acabou de enfileirar espera pelo
      // `po.settled`, e quem registra a análise em voo é a chamada abaixo. O que
      // garante essa ordem não é a posição das linhas aqui: `Po.start`
      // (po/po.ts) põe a análise no conjunto de forma SÍNCRONA, ainda neste
      // tick, enquanto `closeTurn` (board/boardService.ts) só encadeia uma closure
      // — o `waitForPo` de dentro dela roda num microtask posterior, quando o
      // registro já aconteceu nas duas ordens possíveis. Trocar estas duas
      // linhas de lugar não muda nada; o que quebraria a garantia é registrar a
      // análise depois de um `await` em `Po.start`, ou perguntar pelo
      // `poSettled` ainda no tick do evento.
      po.observe(convId, event)
      // O memorista lê o MESMO tee: as chamadas de ferramenta viram evidência do
      // que o turno fez e o `result` dispara a análise. Ele escreve no acervo de
      // memórias, nunca no chat — nada daqui volta para este `emit`.
      memorista.observe(convId, event)
    }
    s = new ProviderFailoverSession(opts, (sessionOptions, sessionEmit, sessionComplete) => new AgentSession(
      sessionOptions,
      getBrowser(convId),
      // Tag every event/permission with the conversation so the renderer can
      // route it to the right chat, even across concurrent sessions. Events are
      // also teed to any connected phones over the remote bridge (SSE).
      sessionEmit,
      (req) => {
        // Pergunta (AskUserQuestion) numa tarefa MCP também volta ao chamador.
        mcpInbound.onPermissionRequest(convId, req)
        send(Channels.agentPermissionRequest, { convId, req })
        if (opts.handoff) handoffTracker.notePermission(convId, req.id, true, req.toolName)
      },
      (id) => {
        mcpInbound.onPermissionClosed(convId, id)
        send(Channels.agentPermissionExpired, { convId, id })
        if (opts.handoff) handoffTracker.notePermission(convId, id, false)
      },
      sessionStore,
      async (sessionId, mirrorFailed) => {
        if (mirrorFailed) {
          await resumeMarker.markSessionResumeReady(convId, sessionId, false)
          throw new StorageError('SESSION_HANDOFF_INCOMPLETE', 'O SDK informou falha no espelhamento do transcript.')
        }
        await verifyMirroredSession(resumeMarker, sessionStore, convId, sessionId, opts.cwd)
      },
      { appRoot: app.getAppPath() },
      sessionComplete,
      // Grava cada chamada de LLM em `llm_calls` (árvore de consumo de tokens),
      // pelo repositório ativo.
      activeTokenUsage(activeRepository),
      // Fila durável de entrada: não ligada aqui (comportamento anterior mantido).
      undefined,
      // Reparo do espelho depois de um mirror_error: reenvia o transcript local
      // por um store que não duplica entradas sem uuid e passa pela MESMA
      // verificação acima — resume_ready só vira true se ela passar.
      async (sessionId, configDir) => {
        // O store de replay tem estado por tentativa: criado agora, no repositório
        // ativo — não no da aquisição, que uma reconexão pode ter fechado.
        const replayStore = activeReplayStore(activeRepository, convId, () => replayDedupStore(sessionStore))
        await replayLocalTranscript(sessionId, replayStore, { cwd: opts.cwd, configDir })
        await verifyMirroredSession(resumeMarker, sessionStore, convId, sessionId, opts.cwd)
      },
      activeContextHistory(activeRepository),
      (event) => send(Channels.contextTurnsChanged, event)
    ), emit, async (provider) =>
      provider === 'gpt' ? isCodexConnected() : claudeAccounts.isConnected(conversationAccount(convId) ?? claudeAccountId),
    async () => {
        if (sessions.get(convId) !== s) return
        // Visível para o `agent:wait-turn-end`: o turno só acabou de fato com o lease solto.
        const release = releaseSessionLease(convId)
        turnLeaseReleases.set(convId, release)
        try {
          await release
        } finally {
          if (turnLeaseReleases.get(convId) === release) turnLeaseReleases.delete(convId)
        }
    },
    // Várias contas Claude: troca de conta no fim do turno e no estouro. A
    // aquisição do lease dela entra no MESMO lock (toda aquisição da conversa
    // passa por ele: nenhuma se cruza com a de um agent:start/agent:send) e, na
    // vez dela, confere se esta sessão ainda é a da conversa.
    withContinueRefusal(convId, accountSwitchDepsFor(convId, () =>
      sessionLock.run(convId, async () => {
        if (sessions.get(convId) !== s) throw new Error('a sessão desta conversa foi trocada antes da troca de conta')
        if (!sessionLeases.has(convId)) await acquireSessionLease(convId)
      })
    )))
    if (!previous) {
      // Defesa: com o lock nada sobe no meio e a descartada já saiu do mapa; se
      // ainda assim houver outra lá, ela é substituída agora — com dispose.
      const stale = sessions.get(convId)
      stale?.dispose()
      if (stale) handoffTracker.sessionEnded(convId)
      sessions.set(convId, s)
      // Sessão nova: o turno de tarefa MCP que estava aberto se perdeu (erro).
      mcpInbound.onSessionInstalled(convId)
    }
    // Sem prazo aqui de propósito: `start()` não espera o CLI responder (cria o
    // `query()` e devolve), só lê disco local e sobe o proxy local do Codex. Um
    // prazo por fora deixaria o CLI subir DEPOIS do dispose, como processo órfão.
    let ok = false
    try {
      ok = await s.start()
      if (ok) {
        logSession('session-start', { convId, model: opts.model, effort: opts.effort, account: claudeAccountId, resume: !!opts.resume })
      }
    } catch (error) {
      console.error(`Agent failed to start for conversation ${convId}:`, error)
    }
    if (!ok) {
      if (sessions.get(convId) === s) sessions.delete(convId)
      s.dispose()
      // A antiga (keepPrevious) segue viva e dona do lease — e com o estado dela
      // (Manager, Automático, pasta), que a troca não chegou a gravar.
      if (!previous) await releaseSessionLease(convId)
    } else if (previous) {
      if (sessions.get(convId) !== previous) {
        // A conversa foi descartada durante a subida (agent:dispose não entra no
        // lock): a nova perde a vez e morre aqui, sem processo órfão.
        s.dispose()
        throw new Error('outra sessão assumiu a conversa durante a troca')
      }
      // A nova subiu: só agora ela vira a da conversa e a antiga é descartada (o
      // `complete` da antiga já não solta o lease: ela deixou de ser a da conversa).
      sessions.set(convId, s)
      commitState(opts.cwd)
      const was = previous.liveOptions()
      logSession('session-replaced', {
        convId, reason: 'mcp-model', background: previous.hasBackgroundWork(), model: was.model, effort: was.effort
      })
      previous.dispose()
      // O dispose não emite `result`/`error`: o turno aberto na antiga acabou aqui.
      handoffTracker.sessionEnded(convId)
      mcpInbound.onSessionInstalled(convId)
    }
    // Escolha provisória (lista de contas não lida do banco) não vai para a conversa.
    return { ok, claudeAccountId: storableSessionAccount(convId, claudeAccountId) }
  }
  ipcMain.handle(Channels.agentStart, (_e, opts: StartAgentOptions) =>
    sessionLock.run(opts.convId, () => startAgentSession(opts))
  )

  /** Id de tarefa MCP vindo da tela (fronteira do IPC): string curta, ou nada. */
  const validTaskId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 200

  /** O estado REAL da sessão viva da conversa: modelo atual e se tem a config MCP. */
  const liveMcpState = (convId: string): LiveSessionState | null => {
    const live = sessions.get(convId)?.liveOptions()
    return live ? { model: live.model, mcp: !!live.inboundMcp } : null
  }

  ipcMain.handle(
    Channels.agentSend,
    async (
      _e,
      convId: string,
      text: string,
      images?: ImageAttachment[],
      files?: FileAttachment[],
      fileRefs?: FileRefAttachment[],
      messageUuid?: string,
      messageKind?: AgentMessageKind,
      mcpTaskId?: unknown
    ) => {
      assertStorageWritable()
      // O item da fila que é de uma tarefa MCP diz QUAL tarefa (o id); sem id, é
      // mensagem do usuário — nunca herda modelo, pin nem config de tarefa. O
      // texto nunca identifica tarefa. `recovery` (retomada automática) é só de
      // mensagem do usuário: nunca continua tarefa.
      const mcpSend: McpSend = {
        text,
        ...(validTaskId(mcpTaskId) ? { taskId: mcpTaskId } : {}),
        kind: messageKind === 'recovery' ? 'recovery' : 'normal',
        ...(typeof messageUuid === 'string' && messageUuid ? { messageUuid } : {})
      }
      // Regra 1: id de tarefa que não está viva (terminou, cancelada, erro, app
      // reiniciado) é RECUSADO — nunca rebaixado a mensagem do usuário. Regra 2:
      // retomada automática depois de turno de tarefa, idem. Conferido aqui, de
      // novo dentro do lock (a tarefa pode ter acabado enquanto esperava) e logo
      // antes de enviar (idem, durante a gravação dos anexos).
      const refuse = (): void => {
        const refused = mcpInbound.refusal(convId, mcpSend)
        if (refused) throw new Error(refused)
      }
      refuse()
      // Conversa com tarefa MCP: a sessão viva tem de estar no modelo (e com a
      // config MCP) que este envio exige — o da tarefa, ou, para a mensagem do
      // usuário depois dela, o da conversa. Não está: refaz a sessão (mesmas
      // opções, retomando a conversa) ANTES de gravar anexos e de avisar vigia,
      // PO e memorista — falhou, nada foi gravado nem anunciado, a tarefa vira
      // erro e o envio também. Nunca roda calado no modelo errado. A troca entra
      // no lock da conversa, como todo agent:start: nada sobe no meio dela. O
      // lock não tem prazo; o lease e a retomada têm (sessionSteps.ts): estourou
      // um deles, a tarefa vira erro com o motivo e o envio falha.
      const target = await sessionLock.run(convId, async () => {
        refuse()
        // Sem sessão viva não há o que refazer nem para onde enviar: erro claro
        // antes de pegar lease (um lease sem sessão ficaria renovando à toa).
        if (!sessions.get(convId)) throw new Error(NO_LIVE_SESSION)
        const acquiredHere = !sessionLeases.has(convId)
        if (acquiredHere) await acquireSessionLease(convId)
        const mcpRestart = mcpInbound.restartForSend(convId, mcpSend, liveMcpState(convId))
        if (mcpRestart) {
          const started = await startAgentSession(mcpRestart, { keepPrevious: true }).catch((error: unknown) => ({
            ok: false,
            error
          }))
          mcpInbound.clearRestart(convId)
          if (!started.ok) {
            const why = 'error' in started ? String(started.error) : 'a sessão não subiu'
            mcpInbound.failStart(convId, mcpSend, `Não consegui trocar o modelo da conversa: ${why}`)
            throw new Error(`Não consegui trocar o modelo da conversa: ${why}`)
          }
        }
        // Depois dos `await` acima (lease, troca): a sessão em que este envio mexe
        // é a que está no mapa AGORA — o descarte da conversa e o lease perdido
        // não entram no lock e tiram a sessão do mapa. Sem sessão viva, erro claro
        // (e a tarefa vira erro), nunca "enviado" para uma sessão descartada. A
        // tarefa também pode ter acabado durante a espera: a recusa vale de novo.
        const session = sessions.get(convId)
        if (!session) {
          // A sessão saiu durante a espera: o lease que ESTA operação pegou não
          // fica instalado sem dona — é solto antes de sair do lock.
          if (acquiredHere) await releaseSessionLease(convId)
          throw new Error(NO_LIVE_SESSION)
        }
        refuse()
        // Tarefa que pediu o modelo: a troca por cota deste turno não troca de modelo.
        session.pinModel(mcpInbound.pinForSend(convId, mcpSend))
        return session
      }).catch((error: unknown) => {
        // A tarefa deste envio vira erro com o motivo (a que já não estava viva
        // não muda — a recusa não mexe nela).
        mcpInbound.failStart(convId, mcpSend, error instanceof Error ? error.message : String(error))
        throw error
      })
      // Non-image files are saved to disk and referenced by path so the agent can
      // open them with its own tools (Read, scripts, etc.). Pasted-by-reference
      // files (fileRefs) are already on disk — local path or main's own
      // download — so they join the same note without another save.
      // Conversa do Agent Manager: nenhum dos três observadores abaixo a acompanha.
      const observed = planningConversations.observed(convId)
      // Imagem também leva o caminho na nota (além do bloco inline): o original
      // quando conhecido, senão uma cópia gravada agora. Sem caminho o agente só
      // via o nome — e o Manager não a traz ao plano com plan_midia_importar.
      const imgs = splitImagesForNote(images)
      const toSave = [...(files ?? []), ...imgs.toSave]
      const saved: Array<{ name: string; path: string }> =
        toSave.length > 0 ? await saveAttachments(convId, toSave) : []
      const finalText = buildAttachmentNote(text, [...saved, ...imgs.refs, ...(fileRefs ?? [])])
      refuse()
      // Tarefa MCP só roda na sessão que foi preparada para ela: se outra assumiu
      // a conversa enquanto os anexos eram gravados, erro claro em vez de rodar
      // no modelo de outra sessão. Mensagem do usuário segue para a da conversa
      // — se ainda houver uma viva; sem nenhuma, erro claro.
      const current = sessions.get(convId)
      if (current !== target && mcpInbound.isTaskSend(convId, mcpSend)) {
        const why = 'Não consegui enviar a tarefa: a sessão da conversa foi trocada durante o envio.'
        mcpInbound.failStart(convId, mcpSend, why)
        throw new Error(why)
      }
      if (!current) throw new Error(NO_LIVE_SESSION)
      // O vigia só julga premissa de um pedido do usuário: é aqui que o turno
      // dele começa (retomada e recuperação de turno não passam por aqui).
      if (observed) vigia.noteUserMessage(convId, sessionCwds.get(convId) ?? '', text)
      // O PO precisa do mesmo marco, e da pasta do projeto para achar o quadro.
      // Aqui também começa a ABERTURA dele: o pedido tem que virar cartão antes
      // de o agente trabalhar, senão o que ele nunca declarar não deixa rastro.
      if (observed) po.noteUserMessage(convId, sessionCwds.get(convId) ?? '', text)
      // O que o fim do turno anterior devolveu para "a fazer" volta para "em
      // andamento" sem depender do PO (gate, cooldown, modelo) — ver
      // `BoardService.resumeTurn`. Nunca rejeita nem segura o envio.
      if (observed) void board.resumeTurn(convId, sessionCwds.get(convId) ?? '')
      // O memorista precisa do mesmo marco: é a mensagem do usuário que pode
      // ENSINAR algo, e a pasta do projeto entra na memória como contexto.
      if (observed) memorista.noteUserMessage(convId, sessionCwds.get(convId) ?? '', text)
      // Saiu da fila o item de uma tarefa MCP: ela passa a `rodando`.
      mcpInbound.onAgentSend(convId, mcpSend)
      // Envio de handoff: o texto CRU casa pelo hash com o prompt registrado
      // (na_fila → enviado). Conversa que não é de handoff o tracker nem olha.
      handoffTracker.noteUserSend(convId, text)
      await current.send(finalText, images, messageUuid, takeOrigin(convId, text), messageKind)
    }
  )

  // A fila da tela só manda o próximo item quando o turno anterior acabou de fato:
  // o `result`/`error` sai ANTES do handoff (verificação do espelho) e do lease
  // solto (onTurnComplete) — e o `agent:send` não pega lease se o antigo ainda
  // está ativo. Sem sessão: na hora. Nunca rejeita; o prazo destrava a fila.
  ipcMain.handle(Channels.agentWaitTurnEnd, async (_e, convId: unknown): Promise<TurnEndWait> => {
    const session = typeof convId === 'string' ? sessions.get(convId) : undefined
    if (!session || typeof convId !== 'string') return { settled: true, reason: 'no-session' }
    const ended = (async (): Promise<'idle'> => {
      await session.waitForIdle().catch(() => undefined)
      // O onTurnComplete corre no mesmo `handoffReady`: uma volta do loop e o
      // lease solto dele já está registrado.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await turnLeaseReleases.get(convId)?.catch(() => undefined)
      return 'idle'
    })()
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), TURN_END_WAIT_MS)
    })
    const reason = await Promise.race([ended, deadline])
    clearTimeout(timer)
    if (reason === 'timeout') console.warn(`[queue] turno de ${convId} não terminou em ${TURN_END_WAIT_MS} ms; a fila segue`)
    return { settled: reason !== 'timeout', reason }
  })

  // Botão "agora" da fila: a mensagem entra no turno em andamento, marcada como
  // ajuste (ver injectNow.ts). Sem turno, `ok: false` e ela segue na fila.
  ipcMain.handle(
    Channels.agentInjectNow,
    async (
      _e,
      convId: unknown,
      text: unknown,
      images?: ImageAttachment[],
      files?: FileAttachment[],
      fileRefs?: FileRefAttachment[],
      messageUuid?: unknown,
      mcpTaskId?: unknown
    ) => {
      if (typeof convId !== 'string' || typeof text !== 'string') return { ok: false }
      // O item clicado diz de qual tarefa MCP é (id); sem id, é do usuário.
      const taskId = validTaskId(mcpTaskId) ? mcpTaskId : undefined
      // Regra 1: id de tarefa que não está viva é recusado (`gone`): a tela tira
      // o item da fila e avisa — nunca entra no turno como mensagem do usuário.
      const gone = mcpInbound.refusal(convId, { text, ...(taskId ? { taskId } : {}) })
      if (gone) return { ok: false, reason: gone, gone: true }
      const session = sessions.get(convId)
      if (!session) return { ok: false }
      // Tarefa MCP de outro modelo (ou sem a config MCP na sessão viva) não entra
      // no turno em andamento: fica na fila e sai no fim dele, com a troca de
      // sessão do `agent:send`. Recusada antes de gravar qualquer anexo — pelo
      // modelo da tarefa DO ITEM clicado.
      const blocked = mcpInbound.injectBlocked(convId, taskId, liveMcpState(convId))
      if (blocked) return { ok: false, reason: blocked }
      assertStorageWritable()
      const imgs = splitImagesForNote(images)
      const toSave = [...(Array.isArray(files) ? files : []), ...imgs.toSave]
      const saved = toSave.length > 0 ? await saveAttachments(convId, toSave) : []
      const finalText = buildAttachmentNote(text, [...saved, ...imgs.refs, ...(Array.isArray(fileRefs) ? fileRefs : [])])
      // Depois do `await` dos anexos: a sessão ainda é a da conversa? Descartada
      // ou trocada no meio, nada entra (o item continua na fila).
      if (sessions.get(convId) !== session) return { ok: false }
      const uuid = typeof messageUuid === 'string' ? messageUuid : undefined
      const ok = session.injectNow(finalText, Array.isArray(images) ? images : undefined, uuid)
      // Tarefa MCP levada para dentro do turno pelo "agora": termina com ele (e,
      // se pediu o modelo, a troca por cota do turno não troca de modelo).
      if (ok && mcpInbound.onInjected(convId, taskId)) session.pinModel(true)
      return { ok }
    }
  )

  ipcMain.handle(Channels.agentInterrupt, async (_e, convId: string) => {
    mcpInbound.onInterrupt(convId)
    const session = sessions.get(convId)
    if (session) logSession('session-stop', { convId, reason: 'stop', background: session.hasBackgroundWork() })
    return (await session?.interrupt()) ?? { stillQueued: [] }
  })

  // MCP de entrada: o renderer montou o ouvinte (e carregou as conversas), ou
  // conta que uma tarefa não chegou à conversa / saiu da fila sem rodar.
  ipcMain.handle(Channels.mcpRendererReady, () => mcpInbound.markRendererReady())
  ipcMain.handle(Channels.mcpTaskFailed, (_e, input: unknown) => {
    const v = input as { taskId?: unknown; erro?: unknown; cancelada?: unknown } | null
    if (!v || typeof v.taskId !== 'string' || typeof v.erro !== 'string') return
    mcpInbound.onRendererReport(v.taskId, v.erro.slice(0, 1000), v.cancelada === true)
  })

  ipcMain.handle(Channels.agentSetBypass, (_e, convId: string, on: boolean) => {
    sessions.get(convId)?.setBypass(on)
    // "Permitir tudo" aprova em silêncio as permissões abertas (não as perguntas).
    handoffTracker.noteBypass(convId, on)
  })

  ipcMain.handle(Channels.agentPermissionResponse, (_e, convId: string, res: PermissionResponse) => {
    mcpInbound.onPermissionClosed(convId, res.id)
    sessions.get(convId)?.resolvePermission(res)
    handoffTracker.notePermission(convId, res.id, false)
  })

  ipcMain.handle(Channels.agentQuestionHold, (_e, convId: string, id: string, paused: boolean) => {
    if (typeof id !== 'string' || typeof paused !== 'boolean') return null
    return sessions.get(convId)?.holdQuestion(id, paused) ?? null
  })

  ipcMain.handle(Channels.agentDispose, (_e, convId: string) => {
    mcpInbound.onDispose(convId)
    const disposed = sessions.get(convId)
    if (disposed) logSession('session-disposed', { convId, reason: 'dispose', background: disposed.hasBackgroundWork() })
    disposed?.dispose()
    sessions.delete(convId)
    autoSessions.delete(convId)
    vigia.dispose(convId)
    po.dispose(convId)
    memorista.dispose(convId)
    forgetUsedMemories(convId)
    board.dispose(convId)
    // Descarte não emite `result`/`error`: o turno que estava aberto acabou aqui.
    handoffTracker.sessionEnded(convId)
    sessionCwds.delete(convId)
    planningConversations.forget(convId)
    void releaseSessionLease(convId)
  })

  ipcMain.handle(Channels.agentRefreshUsage, async (_e, convId: string) => {
    await sessions.get(convId)?.refreshUsage()
  })

  // Manual panel controls act on the browser of the conversation being viewed.
  ipcMain.handle(Channels.browserLaunch, async () => {
    if (activeConvId) await getBrowser(activeConvId).ensureLaunched()
  })
  ipcMain.handle(Channels.browserNavigate, (_e, url: string) =>
    activeConvId ? getBrowser(activeConvId).navigate(url) : ''
  )
  ipcMain.handle(Channels.browserBack, () => activeBrowser()?.back())
  ipcMain.handle(Channels.browserForward, () => activeBrowser()?.forward())
  ipcMain.handle(Channels.browserReload, () => activeBrowser()?.reload())
  ipcMain.handle(Channels.browserSetSelectMode, (_e, on: boolean) => activeBrowser()?.setSelectMode(on))
  ipcMain.handle(Channels.browserInput, (_e, ev: BrowserInput) => activeBrowser()?.forwardInput(ev))
  ipcMain.handle(Channels.browserClose, () => activeBrowser()?.close())

  ipcMain.handle(Channels.browserSetViewport, (_e, width: number, height: number) => {
    desiredViewport = { width, height }
    void activeBrowser()?.setViewport(width, height)
  })

  // Tab controls act on the conversation currently shown in the panel. newTab
  // uses getBrowser so "+" can launch the browser for a conversation that has none.
  // Returns the result string so the renderer can surface success/errors (e.g.
  // an Android tab failing because the toolchain isn't installed).
  ipcMain.handle(Channels.browserNewTab, async (_e, kind?: TabKind, url?: string): Promise<string> => {
    if (!activeConvId) return 'Nenhuma conversa ativa.'
    return getBrowser(activeConvId).newTab(kind ?? 'web', url)
  })
  ipcMain.handle(Channels.browserSelectTab, (_e, tabId: string) => activeBrowser()?.selectTab(tabId))
  ipcMain.handle(Channels.browserCloseTab, (_e, tabId: string) => activeBrowser()?.closeTab(tabId))
  ipcMain.handle(Channels.browserSetAndroidSize, (_e, width: number, height: number, dpi?: number) =>
    activeBrowser()?.setAndroidSize(width, height, dpi)
  )

  ipcMain.handle(Channels.browserSetActive, async (_e, convId: string | null) => {
    activeConvId = convId
    const b = convId ? browsers.get(convId) : null
    // Repaint the panel for the newly-shown conversation: either its live page
    // (resized to the current panel) or the empty placeholder if it has none yet.
    if (b) {
      await b.setViewport(desiredViewport.width, desiredViewport.height)
      await b.refreshView()
    } else send(Channels.browserStateChanged, EMPTY_BROWSER_STATE)
  })

  // ---- remote control (smartfone-remote) ----
  // Persist the ON/OFF intent so the bridge auto-starts on the next launch. The
  // HTTP server itself can't survive the process exit, but the user's choice does:
  // "Ligar" → remoteEnabled = true; "Desligar" → false. App close does NOT clear it.
  ipcMain.handle(Channels.remoteStart, async () => {
    assertStorageWritable()
    const info = await remote.start()
    if (info.running) {
      await updateConfig({ remoteEnabled: true })
      relay.start() // dial the VPS broker so remote (off-LAN) access works
    }
    return info
  })
  ipcMain.handle(Channels.remoteStop, async () => {
    assertStorageWritable()
    relay.stop()
    const info = await remote.stop()
    await updateConfig({ remoteEnabled: false })
    return info
  })
  ipcMain.handle(Channels.remoteStatus, () => remote.info())
  ipcMain.handle(Channels.remoteUnpair, () => {
    remote.unpair()
    return remote.info()
  })
  // Depois de dormir ou mudar de rede o WebSocket com o broker quase sempre está
  // morto sem o SO avisar — reconecta na hora em vez de esperar o heartbeat.
  // Mesma razão para o PostgreSQL: se ele caiu enquanto o PC dormia, reabre já
  // em vez de esperar o próximo passo do backoff da reconexão automática.
  powerMonitor.on('resume', () => {
    relay.kick()
    storageLifecycle.resumeReconnect()
  })
  powerMonitor.on('unlock-screen', () => {
    relay.kick()
    storageLifecycle.resumeReconnect()
  })
  ipcMain.handle(Channels.remotePublishState, (_e, state: RemoteStatePayload) => {
    remote.setState(state)
  })
  ipcMain.handle(Channels.remoteBuildApk, async () => {
    const r = await buildRemoteApk(REMOTE_ROOT, (line) =>
      send(Channels.remoteBuildProgress, { line })
    ).catch((err) => ({ ok: false, message: String(err) }))
    send(Channels.remoteBuildProgress, { line: r.message, done: true, ok: r.ok })
    return r
  })

  ipcMain.handle(Channels.browserDispose, async (_e, convId: string) => {
    const b = browsers.get(convId)
    if (!b) return
    browsers.delete(convId)
    await b.close()
    if (activeConvId === convId) {
      activeConvId = null
      send(Channels.browserStateChanged, EMPTY_BROWSER_STATE)
    }
  })
}

const ownsSingleInstance = app.requestSingleInstanceLock()
if (!ownsSingleInstance) app.quit()
// Esquemas privilegiados só se registram antes do ready.
registerMockupScheme()
// Notificação do Windows: o AppUserModelID tem de ser o do atalho do instalador (appId do electron-builder).
if (process.platform === 'win32') app.setAppUserModelId('com.larchertech.agentcode')

/** Os chamados do agente: a notificação do Windows e os avisos da ponte (officeCallCenter.ts). */
function setupOfficeCalls(): void {
  // Viva até o clique ou o fechar: solta, o coletor levaria o clique junto.
  const shown = new Set<Notification>()
  const center = new OfficeCallCenter({
    bridge: remote.officeCalls,
    notify: (e, onClick) => {
      if (!Notification.isSupported()) return
      const n = new Notification({ title: `${e.agente} está te chamando`, body: `${e.projeto} · ${e.titulo}${e.mensagem ? ` — ${e.mensagem}` : ''}` })
      const drop = (): void => void shown.delete(n)
      shown.add(n)
      n.on('click', () => {
        drop()
        onClick()
      })
      n.on('close', drop)
      n.on('failed', drop)
      n.show()
    },
    open: (e) => {
      revealMainWindow()
      send(Channels.officeCallOpen, { id: e.id, convId: e.convId })
    }
  })
  setOfficeCallSink((n) => void center.add(n).catch(() => undefined))
  ipcMain.handle(Channels.officeCallsState, (_e, raw) => {
    const s = parseCallsState(raw)
    if (s) center.state(s)
  })
}

/** Traz a janela para a frente (restaura, mostra e foca). */
function revealMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

// Com `--minimizado` (o cliente MCP abrindo o app), a janela não salta — a não
// ser sem conta Claude conectada, quando o usuário precisa entrar nela.
app.on('second-instance', (_event, argv) => {
  const decision = secondInstanceReveal(argv, mcpInbound.claudeReadyNow)
  if (decision === 'reveal') revealMainWindow()
  else if (decision === 'check') {
    void refreshClaudeReady()
      .then((ready) => {
        if (!ready) revealMainWindow()
      })
      .catch(() => undefined)
  }
})

// No exe portátil o Chromium do Playwright vai embutido em resources/ms-playwright
// (o pacote não tem acesso ao %LOCALAPPDATA%\ms-playwright da máquina de build).
if (app.isPackaged && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(process.resourcesPath, 'ms-playwright')
}

app.whenReady().then(async () => {
  if (!ownsSingleInstance) return
  // Marcos da abertura, na mesma trilha do `bootStage`. "Demora para abrir" é
  // uma reclamação sem conserto enquanto não se sabe QUAL etapa demora: o
  // Electron subindo, o banco (que pode estar numa pasta sincronizada) ou a
  // interface. Sem estes dois, o log só começava depois do trecho mais lento.
  const bootStarted = Date.now()
  initStore() // prepares the legacy SQLite source and cache folders before the v2 migration
  const storeReadyAt = Date.now()
  const cacheInfo = getCacheInfo()
  // Cofre DENTRO da pasta de dados, com a chave no próprio arquivo: é a mesma
  // unidade que o usuário move e faz backup (banco + memórias). Em userData,
  // migrar a pasta levaria a chave e deixaria as senhas para trás.
  configureSecretVault({ directory: join(cacheInfo.dir, 'vault') })
  // Cache/log/backup de versões antigas ainda na pasta sincronizada vão para a
  // raiz local. Em segundo plano (pode ser 1 GB entre volumes); quem usa essas
  // pastas espera por `localLeftoversSettled()`.
  void relocateLocalLeftovers(cacheInfo.dir, cacheInfo.localDir).then(logLeftoverRelocation)
  // Publica "algum agente ocupado?" em disco para o relançador externo
  // (scripts/relaunch-agent-code.ps1). Vem ANTES de inicializar o armazenamento
  // de propósito: ocupação é sobre conversas, não sobre banco. Se a inicialização
  // falhar, o app fica vivo na tela de recuperação — e é exatamente aí que
  // reiniciar resolve. Publicado depois, um app nesse estado nunca escreveria o
  // arquivo e o script recusaria para sempre, sem ninguém entender por quê.
  if (appRestart) stopRestartGuardFile = startRestartGuardFile(appRestart, app.getPath('userData'))
  // Ciclo de vida das sessões em <userData>/logs/sessions.log (sessionLog.ts):
  // antes do registerIpc, que é de onde as sessões sobem.
  initSessionLog(app.getPath('userData'))
  // Travadas da tela em <userData>/logs/travadas.log (freezeLog.ts).
  initFreezeLog(app.getPath('userData'))
  // Mesma pergunta ("algum agente ocupado?"), outro consumidor: enquanto houver
  // turno vivo, o sistema não entra em suspensão por ociosidade — o Windows não
  // conta o trabalho do agente como atividade e dormia no meio da tarefa. Sai
  // do ar assim que o turno termina, e a tela continua apagando normalmente.
  if (appRestart) {
    const coordinator = appRestart
    stopSleepGuard = startSleepGuard({
      blocker: powerSaveBlocker,
      isBusy: () => coordinator.busyNow(),
      isEnabled: () => loadConfig().preventSleepWhileBusy !== false
    })
  }
  authLog('=== main started (new build) ===')
  // Nada de KV antes de o backend autoritativo existir. Sem isto, `kvFacade`
  // fica em "não configurado" e cai no SQLite LEGADO em silêncio — com a janela
  // abrindo antes do banco, seria config velha lida como se fosse a boa.
  configureKvRepositoryOffline()
  // A JANELA VEM ANTES DO BANCO, de propósito. O backend autoritativo pode ser um
  // PostgreSQL remoto: conectar, migrar e ler leva segundos numa rede boa — e numa
  // ruim pode simplesmente não voltar. Com a ordem antiga, qualquer tropeço aqui
  // (uma leitura pendurada, uma exceção antes de `createWindow`) deixava o processo
  // vivo e SEM JANELA NENHUMA: nada na tela, nada para clicar, nada para entender.
  // Agora a interface sobe primeiro e acompanha o estado da persistência pelo
  // `storageStatusChanged` — que por isso é assinado antes de `initialize()`.
  registerIpc()
  // Fora do registerIpc (que os testes chamam sem Electron): protocolo exige o app pronto.
  officeMockup = setupOfficeMockup({ handle: (channel, handler) => ipcMain.handle(channel, handler) })
  setupOfficeCalls()
  // ChatGPT plan usage read off the Codex proxy responses. Account-level, so it
  // is not tied to any conversation: the renderer routes `rate-limit` events
  // straight into its global usage state without looking at `convId`.
  onCodexRateLimit((limits) => {
    for (const status of limits) {
      send(Channels.agentEvent, { convId: 'codex', event: { kind: 'rate-limit', limits: status } })
    }
  })
  // Queda: descarta só a sessão que, com o turno terminado, ainda está sem banco.
  // Volta: renova os leases e dispara o reparo do espelho (sessionStorageRecovery.ts).
  // Se outro dispositivo assumiu na queda, a renovação volta
  // LEASE_HELD_BY_OTHER_DEVICE e o `onLost` do keeper encerra a sessão.
  const sessionStorageRecovery = createSessionStorageRecovery({
    sessions,
    currentState: () => storageLifecycle.status().state,
    forget: (convId) => {
      autoSessions.delete(convId)
      void releaseSessionLease(convId)
    },
    renewLeases: () => {
      for (const keeper of sessionLeases.values()) void keeper.renewNow()
    }
  })
  storageLifecycle.subscribe((status) => {
    send(Channels.storageStatusChanged, status)
    sessionStorageRecovery(status)
    // Boot com o banco offline pula a carga da config; quando ele volta, carrega
    // aqui (idempotente depois do sucesso) e avisa o renderer pelo mesmo evento
    // de config alterada que ele já trata, para reler os interruptores.
    const ready = status.state === 'postgres-ready' || status.state === 'sqlite-ready'
    if (ready && storageLifecycle.canMutate() && !isConfigLoaded()) {
      void initializeConfigPersistence()
        .then(() =>
          send(Channels.storageChanged, [{ changeId: 'config-loaded', entity: 'device-kv', entityId: 'config.loaded' }])
        )
        .catch((error) => authLog(`config load on storage ready failed: ${error instanceof Error ? error.message : String(error)}`))
    }
  })
  storageLifecycle.subscribeChanges((changes) => {
    void (async () => {
      if (changes.some((change) => change.entity.endsWith('-kv') && change.entityId.startsWith('config.'))) {
        // Falha no reload não pode segurar o lote: as mudanças de conversa que
        // vieram junto ainda precisam chegar ao renderer.
        await reloadConfigPersistence().catch((error: unknown) => {
          authLog(`config reload failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      }
      if (changes.some((change) => change.entity.endsWith('-kv') && change.entityId === 'codexAuth')) {
        await initializeCodexAuthPersistence()
      }
      send(Channels.storageChanged, changes)
    })().catch((error) => {
      authLog(`change feed apply failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  const startMinimized = wantsMinimized(process.argv)
  createWindow(startMinimized)
  // MCP de entrada: no boot, sem esperar janela, banco nem login. Porta ocupada
  // na faixa inteira só fica no log — o resto do app segue.
  void mcpInbound.start().catch((error) => {
    console.error(`[mcp-inbound] não subiu: ${error instanceof Error ? error.message : String(error)}`)
  })
  // Leitura do login para o `GET /agent-code` (e para o `--minimizado`: sem
  // conta, a janela vem para a frente). Renovada de tempos em tempos, porque o
  // usuário pode entrar/sair da conta com o app aberto.
  void refreshClaudeReady()
    .then((ready) => {
      if (!ready && startMinimized) revealMainWindow()
    })
    .catch(() => undefined)
  setInterval(() => void refreshClaudeReady().catch(() => undefined), 60_000).unref()
  authLog(
    `boot electron: ${Math.round(process.uptime() * 1000) - (Date.now() - bootStarted)}ms; ` +
      `boot store: ${storeReadyAt - bootStarted}ms; boot janela: ${Date.now() - bootStarted}ms`
  )
  // Sincrono e recursivo em disco (e a pasta de dados pode estar no OneDrive):
  // fora do caminho da janela, onde só atrasava a primeira pintura.
  const skillSync = syncCacheSkills(app.getAppPath(), cacheInfo.dir)
  for (const error of skillSync.errors) console.error(`[skills] ${error}`)
  await bootStage('storage', () =>
    storageLifecycle.initialize({
      location: cacheInfo,
      userDataDir: app.getPath('userData'),
      secureStorage: safeStorage,
      appVersion: app.getVersion()
    })
  )
  const storageAvailable = storageLifecycle.canMutate()
  if (storageAvailable) {
    await bootStage('config', () => initializeConfigPersistence())
    await bootStage('codex-auth', () => initializeCodexAuthPersistence())
    // Migrou levando só o banco? O cofre é reconstruído do espelho. Precisa do
    // banco pronto, por isso não fica junto do configureSecretVault.
    const restored = await bootStage('vault', () => restoreVault())
    if (restored === 'restored') console.log('[vault] cofre restaurado do banco')
    if (restored === 'failed') console.error('[vault] falha ao restaurar o cofre do banco')
  }
  // Contas Claude: conta só na pasta volta à lista; pasta/login que sumiu é
  // recriado da cópia cifrada no banco. Em segundo plano (accounts/accountSync.ts).
  startAccountSync()
  // A persistência já está pronta (ou já falhou de forma conhecida): só agora a
  // interface pode ler config e conversas sem tomar STORAGE_OFFLINE.
  send(Channels.storageStatusChanged, storageLifecycle.status())
  // Índice da Central (lê todas as conversas) aquecido em segundo plano, alguns
  // segundos depois: a 1ª mensagem da Central não espera essa carga.
  if (storageAvailable) centralIpc?.prewarm()
  // Export DIÁRIO — e o arquivo do dia é o gate. `readExportSnapshot()` baixa
  // TODA conversa (payload inteiro) do backend autoritativo; com PostgreSQL
  // remoto isso são dezenas de MB pela internet, e rodava a cada abertura do
  // app mesmo com o arquivo de hoje já gravado. Agora só baixa quando há
  // export a fazer, e nunca na frente da janela: `void`, não `await`.
  // Na raiz local: é um snapshot inteiro (dezenas de MB) por dia, não algo para
  // a pasta sincronizada.
  if (storageAvailable && !existsSync(dailyParquetPath(cacheInfo.localDir))) {
    parquetExportPromise = (async () => {
      const exportSnapshot = await storageLifecycle.repository().readExportSnapshot()
      return exportConversationsParquet(
        cacheInfo.localDir,
        exportSnapshot.conversations,
        cacheInfo.memoriesDir,
        { backend: exportSnapshot.backend, watermark: exportSnapshot.watermark }
      )
    })().catch((error) => {
      authLog(`daily conversation parquet export failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  // Runs outside every chat session. The cheap transcript mtime gate happens
  // before any agent is started, and the persisted timestamp keeps it daily.
  if (storageAvailable) stopMemoryCurator = await startMemoryCuratorScheduler()
  // Devolve à fila a tarefa cujo executor morreu. É a primeira regra do time
  // que roda fora do modelo: quem some no meio do trabalho pode ser justamente
  // o supervisor, então não dá para depender de alguém perceber e agir.
  if (storageAvailable) stopTaskReaper = startTaskReaper(undefined, (line) => console.log(line))
  // A sessão de handoff que morre calada não manda evento: a varredura marca o
  // envio parado e grava o tempo ativo de quem está rodando.
  if (storageAvailable) stopHandoffSweep = startHandoffSweep(handoffTracker, undefined, (line) => console.log(line))
  // Ponte do Chrome do usuário: precisa da config (token) já carregada.
  if (storageAvailable) void startChromeBridge((status) => send(Channels.chromeBridgeStatusChanged, status))
  // Re-arm the LAN remote bridge if the user had it ON before closing the app, so
  // a paired phone reconnects on its own (the fixed token is already persisted).
  if (storageAvailable && loadConfig().remoteEnabled) {
    void remote
      .start()
      .then(() => relay.start())
      .catch(() => {
        /* no LAN / port busy — the user can re-open the panel and try again */
      })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  windowsControl.stop()
  stopChromeBridge()
  for (const b of browsers.values()) void b.close()
  browsers.clear()
  for (const s of sessions.values()) s.dispose()
  sessions.clear()
  planningIpc?.close()
  relay.stop()
  void remote.stop()
  void mcpInbound.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  quitRequested = true
  // Antes de fechar o banco: sem sync nem nova tentativa da lista de contas depois.
  stopAccountSync()
  if (!quitReady) {
    event.preventDefault()
    if (mainWindow && !mainWindow.isDestroyed()) {
      requestRendererCloseFlush()
    } else {
      void closeStorageForQuit()
        .then(() => {
          quitReady = true
          app.quit()
        })
        .catch((error) => console.error('[storage] failed to close before quit:', error))
    }
    return
  }
  windowsControl.stop()
  // O motor de voz local (Kokoro/Parakeet num utilityProcess) pode ter o modelo
  // na GPU: fechar o app sem pará-lo deixaria VRAM presa.
  void stopVoice()
  stopMemoryCurator?.()
  stopMemoryCurator = null
  stopTaskReaper?.()
  stopTaskReaper = null
  stopHandoffSweep?.()
  stopHandoffSweep = null
  stopRestartGuardFile?.()
  stopRestartGuardFile = null
  stopSleepGuard?.()
  stopSleepGuard = null
  planningIpc?.close()
  centralIpc?.dispose()
})
