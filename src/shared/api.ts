import type {
  SecretVaultItem,
  MemoryConflictItem,
  TaskBoard,
  TaskBoardDetail,
  BoardItem,
  BoardItemEvent,
  BoardItemStatus,
  ProjectBoard,
  AgentEventMsg,
  AgentInterruptResult,
  AgentMessageKind,
  AndroidProgressMsg,
  SpeechSetupProgress,
  AppConfig,
  BrowserFrame,
  BrowserInput,
  BrowserState,
  CacheInfo,
  ClaudeAuthStatus,
  CodexStatus,
  FileAttachment,
  FileBytes,
  FileRefAttachment,
  ImageAttachment,
  MentionHit,
  ProjectTree,
  ResolvedPastedRef,
  SkillInfo,
  PermissionExpiredMsg,
  VigiaAlertMsg,
  PoProviderDiagnosticMsg,
  MemoristaProviderDiagnosticMsg,
  PermissionRequestMsg,
  PermissionResponse,
  PickedElement,
  RemoteBuildProgressMsg,
  RemoteInboundMsg,
  RemotePermissionResponseMsg,
  RemoteSetModelMsg,
  RemoteSetModeMsg,
  RemoteConversationAction,
  RemoteInfo,
  RemoteStatePayload,
  StartAgentOptions,
  TabKind,
  PostgresConnectionDraft,
  PostgresPublicSettings,
  StorageStatusDto,
  VersionedConversationDto,
  ConversationQueryDto,
  ProjectConversationCountDto,
  ConversationUpsertDto,
  ConversationDeleteDto,
  RepositoryChange,
  TokenUsageHistory,
  OpenedPlanningDto,
  PlanningCardDto,
  PlanningChangedMsg,
  FlowPdfRequest,
  FlowPdfResult,
  PlanningHandoffDto,
  PlanningImportFile,
  PlanningLayoutDto,
  PlanningMediaContentDto,
  PlanningRef,
  PlanningResult,
  PlanningRoteiroDto,
  PlanMediaDto,
  SuggestTitleResult,
  OutboxEntryDto
} from './ipc'
import type {
  AccountUsageResult,
  AddClaudeAccountResult,
  ClaudeAccountView,
  UseAccountResult
} from './claudeAccounts'
import type { TypeSafePauseStatus } from './typesafePause'

/** The surface exposed on `window.api` by the preload script. */
export interface AgentCodeApi {
  /** App version from package.json (matches the installer/build). */
  getAppVersion(): Promise<string>
  /** Read the persisted app configuration. */
  getConfig(): Promise<AppConfig>
  /** Persist a partial app configuration (merged with what's on disk). */
  setConfig(patch: Partial<AppConfig>): Promise<void>
  /** Whether TypeSafe is enabled and has a usable API key (config or vault). */
  isTypeSafeConfigured(): Promise<boolean>
  /** Flush request sent before Electron allows the window to close. */
  onAppCloseRequested(cb: () => void): () => void
  /** Confirm that pending durable writes finished and the window may close. */
  appCloseReady(): Promise<void>
  /** Flush request sent before Electron reloads the renderer. */
  onAppReloadRequested(cb: () => void): () => void
  /** Confirm that pending durable writes finished and the renderer may reload. */
  appReloadReady(): Promise<void>
  getStorageStatus(): Promise<StorageStatusDto>
  getPostgresSettings(): Promise<PostgresPublicSettings>
  testPostgresConnection(draft: PostgresConnectionDraft): Promise<void>
  activatePostgres(draft: PostgresConnectionDraft): Promise<boolean>
  deactivatePostgres(): Promise<boolean>
  retryStorage(draft?: PostgresConnectionDraft): Promise<void>
  clearPostgresPassword(): Promise<void>
  onStorageStatusChanged(cb: (status: StorageStatusDto) => void): () => void
  onStorageFlushRequested(cb: (requestId: string) => void): () => void
  storageFlushReady(requestId: string, error?: string): Promise<void>
  onStorageChanged(cb: (changes: RepositoryChange[]) => void): () => void
  loadVersionedConversations(query?: ConversationQueryDto): Promise<VersionedConversationDto[]>
  /** Live conversation count per project, for the sidebar badge when only the
   *  first page of each project is loaded. */
  countConversationsByProject(): Promise<ProjectConversationCountDto[]>
  upsertConversation(input: ConversationUpsertDto): Promise<VersionedConversationDto>
  deleteConversation(input: ConversationDeleteDto): Promise<VersionedConversationDto>
  /** Toggle the independent high-risk permission for controlling Windows apps. */
  setWindowsControlEnabled(enabled: boolean): Promise<void>
  /** Keep every renderer surface synchronized with the Windows-control gate. */
  onWindowsControlChanged(cb: (enabled: boolean) => void): () => void
  /** Whether a path exists and is a directory (project-folder guard). */
  pathExists(path: string): Promise<boolean>
  pickDirectory(): Promise<string | null>
  /** Native file picker — returns the absolute path, or null if canceled. */
  pickFile(): Promise<string | null>
  /** Open a project folder in VS Code. Returns a status (success or why it failed). */
  openInEditor(dir: string): Promise<{ ok: boolean; message: string }>
  /** Open a project folder in the OS file explorer. Returns a status. */
  openInFolder(dir: string): Promise<{ ok: boolean; message: string }>
  /** Live "@" autocomplete: files/folders under `root` matching `query` (≤ limit hits). */
  mentionSearch(root: string, query: string): Promise<MentionHit[]>
  /** "/" autocomplete: skills available to the agent (project + active cache + user-level). */
  listSkills(root: string): Promise<SkillInfo[]>
  /** Project map: the most recently modified files under `root` (+ their folders).
   *  `keep` = paths the caller is showing now, so the reply can report which of
   *  them were deleted (see ProjectTree.missing). */
  projectTree(root: string, keep?: string[]): Promise<ProjectTree>
  /** Icon found inside the project folder (data URL), or null when it has none. */
  projectIcon(root: string): Promise<string | null>
  /** Save a copy of a file (created by the agent) to Downloads and reveal it. */
  downloadFile(path: string): Promise<{ ok: boolean; message: string; saved?: string }>
  /** Read the content of a local file (e.g. for previewing in the UI). */
  readFile(path: string): Promise<string>
  /** Read a local file as base64 bytes — for binary previews (PDF, images, xlsx…). */
  readFileBytes(path: string): Promise<FileBytes>
  /** Resolve a composer-pasted line as a local file path (stat only, no bytes read). */
  resolvePastedPath(path: string): Promise<ResolvedPastedRef>
  /** Download a composer-pasted http(s) file URL to disk (streamed, no bytes over IPC). */
  downloadPastedUrl(url: string, convId: string): Promise<ResolvedPastedRef>
  /** Absolute path a pasted/dropped `File` points to, or '' if it has no real
   *  file on disk (e.g. a blob built in JS). Synchronous (runs in preload). */
  getPathForFile(file: File): string
  /** Read the active cache folder (SQLite db + .md memories location). */
  getCacheInfo(): Promise<CacheInfo>
  /** Pick a new cache folder and switch to it; resolves null if the dialog was canceled. */
  chooseCacheDir(): Promise<CacheInfo | null>
  /** Read a value (JSON string) from the cache-folder SQLite key→value store. */
  /** Vault entries for Configurações: names and dates, never a value. */
  listSecrets(): Promise<SecretVaultItem[]>
  /** Explicit deletion of one vault entry. */
  deleteSecret(name: string): Promise<boolean>
  /** Memory proposals that failed to apply. */
  listMemoryConflicts(): Promise<MemoryConflictItem[]>
  /** Removes one settled proposal from the conflicts list. */
  discardMemoryProposal(id: string): Promise<boolean>
  /** Task ledger queue for the agents panel. Read-only: the panel never moves a task. */
  tasksBoard(query?: { projectCwd?: string; conversationId?: string; includeFinished?: boolean }): Promise<TaskBoard>
  /** Steps, deliverables and events of one task — only fetched when it is expanded. */
  tasksDetail(taskId: string): Promise<TaskBoardDetail | null>
  /** Quadro de tarefas do projeto: cartões do agente com a camada do PO por cima. */
  boardList(query: {
    projectCwd: string
    conversationId?: string
    includeDismissed?: boolean
  }): Promise<ProjectBoard>
  /** Arquiva/desarquiva um cartão — a única escrita do usuário no quadro. */
  boardDismiss(id: string, dismissed: boolean): Promise<BoardItem | null>
  /** Drag-and-drop no Quadro: move o cartão de coluna. Quando o destino é
   *  "fazendo", manda o agente começar (enfileira se ele estiver ocupado);
   *  quando o cartão SAI de "fazendo", interrompe o turno de verdade. `ok:
   *  false` quando não há sessão viva para mandar a mensagem — nada é
   *  gravado, e a UI deve desfazer a posição do cartão. */
  boardMove(id: string, toStatus: BoardItemStatus): Promise<{ ok: boolean; message?: string }>
  /** A linha do tempo de um cartão — só buscada quando o detalhe abre. */
  boardItemEvents(boardItemId: string): Promise<BoardItemEvent[]>
  /** O quadro daquele projeto mudou (o agente avançou, ou o PO corrigiu). */
  onBoardChanged(cb: (msg: { projectId: string }) => void): () => void
  /** Tela de Planejamento (pasta de dados do app: <dataDir>/planning/<projeto>/<slug>/;
   *  o plano aberto traz a pasta real em `dir`). Nada lança: erro vem como
   *  `{ ok: false, code }` — 'rev_conflict' traz o card atual em disco e
   *  'roteiro_conflict', o roteiro atual. */
  planningList(req: { projectCwd: string }): Promise<PlanningResult<{ slugs: string[] }>>
  planningCreate(req: PlanningRef & { titulo: string }): Promise<PlanningResult<{ plan: OpenedPlanningDto }>>
  /** Abre e passa a vigiar a pasta; reabrir (para recarregar) não duplica a vigia. */
  planningOpen(req: PlanningRef): Promise<PlanningResult<{ plan: OpenedPlanningDto }>>
  /** Para de vigiar o planejamento aberto por esta janela. */
  planningClose(req: PlanningRef): Promise<PlanningResult>
  /** Grava se `expectedRev` é o rev em disco (0 = card novo); devolve o card com rev + 1. */
  planningSaveCard(
    req: PlanningRef & { card: PlanningCardDto; expectedRev: number }
  ): Promise<PlanningResult<{ card: PlanningCardDto }>>
  planningDeleteCard(req: PlanningRef & { id: string; expectedRev: number }): Promise<PlanningResult>
  /** Grava se `expectedRev` é o rev do roteiro em disco; devolve o roteiro com rev + 1. */
  planningSaveRoteiro(
    req: PlanningRef & { roteiro: Omit<PlanningRoteiroDto, 'rev'>; expectedRev: number }
  ): Promise<PlanningResult<{ roteiro: PlanningRoteiroDto }>>
  planningSaveLayout(req: PlanningRef & { layout: PlanningLayoutDto }): Promise<PlanningResult>
  /** Os prompts de _handoff/ do planejamento, na ordem em que foram gravados. */
  planningListHandoffs(req: PlanningRef): Promise<PlanningResult<{ handoffs: PlanningHandoffDto[] }>>
  /** Grava um prompt em _handoff/AAAA-MM-DD-NN.md; devolve o nome do arquivo novo. */
  planningWriteHandoff(req: PlanningRef & { conteudo: string }): Promise<PlanningResult<{ name: string }>>
  /** Importa arquivos para <plano>/midia/ (nome saneado): arrastado do Explorer vai
   *  por `{ path }` (getPathForFile), colado vai por `{ name, data }` em base64.
   *  Devolve as mídias novas, na ordem de `files`. */
  planningImportMedia(
    req: PlanningRef & { files: PlanningImportFile[] }
  ): Promise<PlanningResult<{ media: PlanMediaDto[] }>>
  /** Uma mídia de <plano>/midia/ em base64 (até MAX_MEDIA_PREVIEW_BYTES), para miniatura. */
  planningReadMedia(req: PlanningRef & { name: string }): Promise<PlanningResult<PlanningMediaContentDto>>
  /** Pergunta onde salvar e grava o flow do planejamento em PDF. */
  planningExportPdf(req: FlowPdfRequest): Promise<FlowPdfResult>
  /** Arquivos de um planejamento aberto mudaram por fora do app — recarregue. */
  onPlanningChanged(cb: (msg: PlanningChangedMsg) => void): () => void
  kvGet(key: string): Promise<string | null>
  /** Write a value (JSON string) into the cache-folder SQLite key→value store. */
  kvSet(key: string, value: string): Promise<void>
  /** Load every conversation from every per-project db under `data/` (merged). */
  loadAllConversations(): Promise<unknown[]>
  /** Persist the full conversation list, split one db per project (`cwd`). */
  saveAllConversations(list: unknown[]): Promise<void>
  /** Nome curto (claude-haiku-4-5, one-shot) para a conversa a partir da 1ª
   *  mensagem. Nunca lança: `ok: false` quando não houver título. */
  suggestConversationTitle(req: { text: string; convId?: string }): Promise<SuggestTitleResult>

  /** Transcribe recorded audio (base64) to text via OpenAI. `error: 'no-key'`
   *  means the user hasn't set an OpenAI API key yet. */
  transcribeAudio(
    audioBase64: string,
    mimeType: string
  ): Promise<{ ok: boolean; text?: string; error?: string }>
  /** Synthesize speech (base64 MP3) from already-treated text via OpenAI. */
  speak(
    text: string
  ): Promise<{ ok: boolean; audioBase64?: string; mimeType?: string; error?: string }>
  /** Whether a Claude Code login already exists. */
  authStatus(): Promise<{ authenticated: boolean }>
  /** Trigger the Claude OAuth login (opens the system browser); resolves when done. */
  authLogin(): Promise<{ ok: boolean }>
  /** Erase the saved Claude OAuth login (+ stale caches); resolves with the verified status. */
  authLogout(): Promise<ClaudeAuthStatus>
  /** Contas Claude na ordem do usuário (sem token nenhum). */
  claudeAccountsList(): Promise<ClaudeAccountView[]>
  /** Login OAuth de uma conta nova pelo navegador, numa pasta própria. */
  claudeAccountsAdd(): Promise<AddClaudeAccountResult>
  /** "Entrar de novo" numa conta com login expirado. */
  claudeAccountsRelogin(id: string): Promise<{ ok: boolean }>
  claudeAccountsRename(id: string, label: string): Promise<{ ok: boolean }>
  claudeAccountsReorder(ids: string[]): Promise<{ ok: boolean }>
  /** Remove a conta e apaga a pasta dela (a conta padrão não sai). */
  claudeAccountsRemove(id: string): Promise<{ ok: boolean }>
  /** Consumo das contas, consultado de verdade (cache de 60 s; falha = última leitura). */
  claudeAccountsUsage(force?: boolean, accountId?: string): Promise<AccountUsageResult[]>
  /** "Usar nesta conversa" / "Continuar na conta X" (continueTask retoma a tarefa preservada). */
  claudeAccountsUseForConversation(convId: string, accountId: string, continueTask?: boolean): Promise<UseAccountResult>
  /** Lê (sem argumento) ou grava o interruptor "Troca automática de conta". */
  claudeAccountsAutoSwitch(on?: boolean): Promise<boolean>
  /** Pausa atual do roteamento TypeSafe. */
  typeSafePauseStatus(): Promise<TypeSafePauseStatus>
  /** main → renderer: o roteamento TypeSafe entrou em pausa. */
  onTypeSafePaused(cb: (status: TypeSafePauseStatus) => void): () => void
  /** Whether a Codex (ChatGPT subscription) login already exists. */
  codexStatus(): Promise<CodexStatus>
  /** Trigger the Codex OAuth login (opens the system browser); resolves when tokens are saved. */
  codexLogin(): Promise<{ ok: boolean; message?: string }>
  /** Erase the saved Codex login. */
  codexLogout(): Promise<void>

  startAgent(opts: StartAgentOptions): Promise<{ ok: boolean; claudeAccountId?: string }>
  /** Fila de espera gravada no banco: tudo, no boot. */
  outboxList(): Promise<OutboxEntryDto[]>
  /** Regrava a fila de UMA conversa (lista vazia apaga). */
  outboxReplace(conversationId: string, items: Array<{ id: string; payload: unknown }>): Promise<{ ok: boolean }>
  /** Botão "agora": põe a mensagem da fila no turno em andamento, sem
   *  interromper. `ok: false` = não havia turno (ou era uma troca de conta): a
   *  mensagem continua na fila. */
  injectNow(
    convId: string,
    text: string,
    images?: ImageAttachment[],
    files?: FileAttachment[],
    fileRefs?: FileRefAttachment[],
    messageUuid?: string
  ): Promise<{ ok: boolean }>
  sendMessage(
    convId: string,
    text: string,
    images?: ImageAttachment[],
    files?: FileAttachment[],
    fileRefs?: FileRefAttachment[],
    /** Stable SDK uuid used to correlate an interrupt receipt with this bubble. */
    messageUuid?: string,
    /** Internal recovery prompts must not start a new loop activation. */
    messageKind?: AgentMessageKind
  ): Promise<void>
  interrupt(convId: string): Promise<AgentInterruptResult>
  /** Toggle "allow all" on a conversation's running session. */
  setBypass(convId: string, on: boolean): Promise<void>
  respondPermission(convId: string, res: PermissionResponse): Promise<void>
  /** Pausa (pergunta minimizada) ou renova o prazo de uma pergunta pendente;
   *  devolve o novo deadline, ou null quando pausada. */
  holdQuestion(convId: string, id: string, paused: boolean): Promise<number | null>
  /** Dispose a conversation's agent session (on chat deletion). */
  disposeAgent(convId: string): Promise<void>
  /** Poll the latest account-wide rate-limit snapshot for a connected session. */
  refreshUsage(convId: string): Promise<void>
  /** Persisted LLM calls + aggregated totals of a conversation, to rebuild the
   *  token-usage tree when reopening an old conversation. */
  getTokenUsageHistory(convId: string): Promise<TokenUsageHistory>
  onAgentEvent(cb: (e: AgentEventMsg) => void): () => void
  onPermissionRequest(cb: (m: PermissionRequestMsg) => void): () => void
  /** Subscribe to permission/question timeouts (auto-resolved) so the renderer
   *  can close the matching modal. Returns an unsubscribe function. */
  onPermissionExpired(cb: (m: PermissionExpiredMsg) => void): () => void
  /** Subscribe to the parallel watcher's doubts about a premise of the work.
   *  Advisory only: nothing is paused, the user decides what to do. */
  onVigiaAlert(cb: (m: VigiaAlertMsg) => void): () => void
  /** Safe lifecycle notifications for the PO Claude → GPT Luna fallback. */
  onPoProviderDiagnostic(cb: (m: PoProviderDiagnosticMsg) => void): () => void
  /** Safe lifecycle notifications for the memorista's Claude → GPT Luna fallback. */
  onMemoristaProviderDiagnostic(cb: (m: MemoristaProviderDiagnosticMsg) => void): () => void

  launchBrowser(): Promise<void>
  navigate(url: string): Promise<string>
  browserBack(): Promise<void>
  browserForward(): Promise<void>
  browserReload(): Promise<void>
  setSelectMode(on: boolean): Promise<void>
  sendBrowserInput(ev: BrowserInput): Promise<void>
  closeBrowser(): Promise<void>
  /** Resize the active browser's viewport (CSS px) to match the panel. */
  setBrowserViewport(width: number, height: number): Promise<void>
  /** Switch the panel to a conversation's browser (null = none). */
  setActiveBrowser(convId: string | null): Promise<void>
  /** Close and forget a conversation's browser. */
  disposeBrowser(convId: string): Promise<void>
  /** Open a new preview tab (defaults to web) on the active browser. Returns a
   *  status string (success message, or why it failed — e.g. Android toolchain missing). */
  newTab(kind?: TabKind, url?: string): Promise<string>
  /** Make a tab the active (controlled/streamed) one. */
  selectTab(tabId: string): Promise<void>
  /** Close a preview tab. */
  closeTab(tabId: string): Promise<void>
  /** Set the active Android preview's screen size (px) — a device model or custom. */
  setAndroidSize(width: number, height: number, dpi?: number): Promise<string>
  onBrowserFrame(cb: (f: BrowserFrame) => void): () => void
  onBrowserState(cb: (s: BrowserState) => void): () => void
  onBrowserPicked(cb: (el: PickedElement) => void): () => void
  /** Boot-progress lines while a conversation's Android device/emulator starts. */
  onAndroidProgress(cb: (m: AndroidProgressMsg) => void): () => void
  /** Progress while the on-device speech model is downloaded/prepared (local
   *  dictation engine). Ends with stage 'done' or 'error'. */
  onSpeechSetupProgress(cb: (p: SpeechSetupProgress) => void): () => void

  // ---- remote control (smartfone-remote) ----
  /** Start the LAN bridge so a phone can drive the sessions. */
  remoteStart(): Promise<RemoteInfo>
  /** Stop the LAN bridge. */
  remoteStop(): Promise<RemoteInfo>
  /** Current bridge status (running, url, token, connected phones). */
  remoteStatus(): Promise<RemoteInfo>
  /** Publish the latest conversation snapshot for the bridge to serve to phones. */
  publishRemoteState(state: RemoteStatePayload): Promise<void>
  /** Build the Android remote APK (smartfone-remote). Progress via onRemoteBuildProgress. */
  buildRemoteApk(): Promise<{ ok: boolean; apkPath?: string; message: string }>
  /** A command arrived from a phone — dispatch it into its conversation. */
  onRemoteInbound(cb: (m: RemoteInboundMsg) => void): () => void
  /** A phone toggled the global "Permitir tudo" switch — apply it on the PC. */
  onRemoteSetSkipPerms(cb: (m: { on: boolean }) => void): () => void
  /** A phone asked to change a conversation's model/effort — apply it on the PC. */
  onRemoteSetModel(cb: (m: RemoteSetModelMsg) => void): () => void
  onRemoteRecoveryAction(cb: (m: { convId: string; action: 'retry' | 'cancel' }) => void): () => void
  /** A phone answered a pending permission/question — resolve it locally too. */
  onRemotePermissionResponse(cb: (m: RemotePermissionResponseMsg) => void): () => void
  /** A phone asked to stop the running turn of a conversation. */
  onRemoteInterrupt(cb: (m: { convId: string }) => void): () => void
  /** A phone toggled a per-conversation mode (economy/loop/fast). */
  onRemoteSetMode(cb: (m: RemoteSetModeMsg) => void): () => void
  /** A phone created/renamed/deleted a conversation. */
  onRemoteConversationAction(cb: (m: RemoteConversationAction) => void): () => void
  /** Forget the paired phone so a new one can pair. */
  remoteUnpair(): Promise<RemoteInfo>
  /** Progress lines while the remote APK is built. */
  onRemoteBuildProgress(cb: (m: RemoteBuildProgressMsg) => void): () => void
  /** The connected-phone count changed. */
  onRemoteClients(cb: (info: RemoteInfo) => void): () => void
}
