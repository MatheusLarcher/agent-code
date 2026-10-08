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
  TurnEndWait,
  AgentMessageKind,
  AndroidProgressMsg,
  SpeechSetupProgress,
  VoiceInstallStatus,
  VoiceComponent,
  VoiceSelfTest,
  AndroidToolchainStatus,
  AppConfig,
  BrowserFrame,
  BrowserInput,
  BrowserState,
  CacheInfo,
  ClaudeAuthStatus,
  CodexStatus,
  ProvidersStatus,
  SandboxCreateResult,
  FileAttachment,
  FileBytes,
  FileRefAttachment,
  ImageAttachment,
  MentionHit,
  ProjectDirListing,
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
  McpCancelQueuedMsg,
  McpInboundMsg,
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
  TurnTimeTotals,
  OpenedPlanningDto,
  PlanningCardDto,
  PlanningChangedMsg,
  FlowPdfRequest,
  FlowPdfResult,
  PlanningHandoffListDto,
  PlanningHandoffSentDto,
  PlanningHandoffSentMark,
  PlanningImportFile,
  PlanningLayoutDto,
  PlanningMediaContentDto,
  PlanningRef,
  PlanningResult,
  PlanningRoteiroDto,
  PlanMediaDto,
  SuggestTitleResult,
  OutboxEntryDto,
  WhisperStatus,
  FreezeLogApi
} from './ipc'
import type {
  AccountUsageResult,
  AddClaudeAccountResult,
  ClaudeAccountView,
  UseAccountResult
} from './claudeAccounts'
import type { ContextTurnSummary, ContextTurnDetail, ContextExactCount, ContextTurnChanged } from './contextSnapshot'
import type { TypeSafePauseStatus } from './typesafePause'
import type { ChromeBridgeStatus } from './chromeBridge'
import type { OfficeApi } from './officeApi'
import type { CentralCorrection, CentralRouteRequest, CentralRouteResult, RemoteCentralChoose } from './central'
import type { HandoffEnvio, HandoffQueueDecision, HandoffQueueItem } from './handoffTracking'
import type { HandoffProjectAction, HandoffProjectSnapshot } from './handoffProject'
import type { PoAuthorizationMap } from './poAuthorization'
import type { BoardPrintImageResult, BoardPrintsResult } from './boardPrints'
import type { PoChatMessage } from './poChat'
import type { ProjectColorMap } from './projectColor'

/** Um prompt do handoff a registrar: o arquivo de _handoff/ e o texto EXATO enviado. */
export interface HandoffRegisterPrompt {
  arquivo: string
  conteudo: string
}

/** Pedido de Channels.handoffRegister: os prompts na ordem de envio, já pareados com o arquivo. */
export interface HandoffRegisterRequest {
  projectCwd: string
  slug: string
  conversationId: string
  conversationTitle: string
  prompts: HandoffRegisterPrompt[]
}

/** Resposta de Channels.handoffRegister. Sem banco gravável, `envios` vem vazio. */
export type HandoffRegisterResult = { ok: true; envios: HandoffEnvio[] } | { ok: false; message: string }

/** Pedido de Channels.handoffList. Sem filtro = todos os projetos; os dois filtros juntos se somam. */
export interface HandoffListRequest {
  conversationId?: string
  /** Caminho absoluto do projeto (vira a identidade estável dele, como no Quadro). */
  projectCwd?: string
  /** Padrão 200, teto 1000. */
  limit?: number
}

/** Sem banco gravável vem `{ ok: false }` — lista vazia diria "nenhum envio", o que seria mentira. */
export type HandoffListResult = { ok: true; envios: HandoffEnvio[] } | { ok: false; message: string }

/** Pedido de Channels.handoffCorrectEntrega: a correção é do usuário e o acompanhamento a respeita. */
export interface HandoffCorrectEntregaRequest {
  entregaId: string
  acao: 'concluir' | 'reabrir'
  /** Até 500 caracteres; vai para o motivo depois de "corrigido por você". */
  motivo?: string
}

/** Devolve o envio-pai já reavaliado. */
export type HandoffCorrectEntregaResult = { ok: true; envio: HandoffEnvio } | { ok: false; message: string }

/** Channels.handoffQueueGate. `force`: o "Enviar mesmo assim" (solta mesmo com o anterior não concluído). */
export interface HandoffQueueGateRequest {
  conversationId: string
  force?: boolean
}
export type HandoffQueueGateResult = { ok: true; decision: HandoffQueueDecision } | { ok: false; message: string }

/** Channels.handoffQueueDispatched: `dispatched: false` = já tinha saído (não mande de novo). */
export interface HandoffQueueDispatchedRequest {
  conversationId: string
  envioId: string
}
export type HandoffQueueDispatchedResult = { ok: true; dispatched: boolean } | { ok: false; message: string }

/** Channels.handoffQueueList: sem `projectCwd`, todas as pastas. */
export interface HandoffQueueListRequest {
  projectCwd?: string
}
export type HandoffQueueListResult = { ok: true; items: HandoffQueueItem[] } | { ok: false; message: string }

/** Main → renderer (Channels.handoffChanged): algo mudou nos envios daquela conversa — releia. */
export interface HandoffChangedMsg {
  conversationId: string
}

/** Channels.handoffProjectStatus: a foto da fila do projeto (todas as pastas deste PC). */
export type HandoffProjectStatusResult = { ok: true; snapshot: HandoffProjectSnapshot } | { ok: false; message: string }

/** Channels.handoffProjectAction: a ação do usuário, na conversa do plano. */
export interface HandoffProjectActionRequest {
  conversationId: string
  acao: HandoffProjectAction
}
export type HandoffProjectActionResult = { ok: true } | { ok: false; message: string }

/** Channels.handoffProjectReply: `stored: false` = a conversa está livre e a mensagem pode sair. */
export interface HandoffProjectReplyRequest {
  conversationId: string
  texto: string
}
export type HandoffProjectReplyResult = { ok: true; stored: boolean } | { ok: false; message: string }

/** Channels.handoffQueueEdit: só prompt que ainda não saiu. */
export type HandoffQueueEditRequest = { envioId: string; acao: 'tirar' } | { envioId: string; acao: 'editar'; conteudo: string }
/** Resultado das ações da faixa (editar, reordenar). */
export type HandoffQueueEditResult = { ok: true } | { ok: false; message: string }

/** Channels.handoffQueueReorder: os prompts de UM plano, na ordem nova. */
export interface HandoffQueueReorderRequest {
  conversationId: string
  envioIds: string[]
}

/** Channels.handoffProjectReorder: os planos da pasta, na ordem nova. */
export interface HandoffProjectReorderRequest {
  projectCwd: string
  loteIds: string[]
}

/** Channels.handoffProjectDirty: `files: null` = sem git (não deu para conferir). */
export type HandoffProjectDirtyResult = { ok: true; files: string[] | null } | { ok: false; message: string }

/** Channels.poAuthorizationList. */
export type PoAuthorizationListResult = { ok: true; authorizations: PoAuthorizationMap } | { ok: false; message: string }

/** The surface exposed on `window.api` by the preload script. */
/** A window.api; a parte do Escritório está em officeApi.ts e a do detector de travadas em FreezeLogApi. */
export interface AgentCodeApi extends OfficeApi, FreezeLogApi {
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
  /** Liga/desliga a permissão do controle do Chrome do usuário. */
  setChromeControlEnabled(enabled: boolean): Promise<void>
  onChromeControlChanged(cb: (enabled: boolean) => void): () => void
  /** Status da ponte Chrome (extensão conectada, versão, navegador). */
  getChromeBridgeStatus(): Promise<ChromeBridgeStatus>
  onChromeBridgeStatusChanged(cb: (status: ChromeBridgeStatus) => void): () => void
  /** Copia/atualiza a extensão, abre a pasta e chrome://extensions; devolve o caminho da pasta. */
  installChromeExtension(): Promise<string>
  /** Whether a path exists and is a directory (project-folder guard). */
  pathExists(path: string): Promise<boolean>
  pickDirectory(): Promise<string | null>
  /** Native file picker — returns the absolute path, or null if canceled. */
  pickFile(): Promise<string | null>
  /** Open a project folder in VS Code. Returns a status (success or why it failed). */
  openInEditor(dir: string): Promise<{ ok: boolean; message: string }>
  /** Open a project folder in the OS file explorer. Returns a status. */
  openInFolder(dir: string): Promise<{ ok: boolean; message: string }>
  /** A memória ou o arquivo do projeto da conversa: o Explorador com ele selecionado ('folder') ou o programa padrão ('open'). Só no PC. */
  revealFile(req: import('./ipc').RevealFileRequest): Promise<import('./ipc').RevealFileResult>
  /** Live "@" autocomplete: files/folders under `root` matching `query` (≤ limit hits). */
  mentionSearch(root: string, query: string): Promise<MentionHit[]>
  /** "/" autocomplete: skills available to the agent (project + active cache + user-level). */
  listSkills(root: string): Promise<SkillInfo[]>
  /** Project map: the most recently modified files under `root` (+ their folders).
   *  `keep` = paths the caller is showing now, so the reply can report which of
   *  them were deleted (see ProjectTree.missing). */
  projectTree(root: string, keep?: string[]): Promise<ProjectTree>
  /** One folder of the project (`rel` = '' for the root), folders first; never throws (error in the result). */
  projectDir(root: string, rel: string): Promise<ProjectDirListing>
  /** Icon found inside the project folder (data URL), or null when it has none. */
  projectIcon(root: string): Promise<string | null>
  /** Fixed project color per cwd (absolute paths, max 200); detected and pinned in main. */
  projectColors(cwds: string[]): Promise<ProjectColorMap>
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
  /** Rascunho: grava os bytes de um anexo em `<userData>/attachments/<convId>/rascunho/` e devolve o caminho. */
  stashDraftAttachment(
    convId: string,
    file: { name: string; mediaType: string; data: string }
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }>
  /** Rascunho: apaga as cópias do rascunho em `paths` (só as da pasta `rascunho/` da conversa). Devolve quantas. */
  discardDraftAttachments(convId: string, paths: string[]): Promise<number>
  /** Envio: move as cópias do rascunho em `paths` para `<userData>/attachments/<convId>/` (mesmo nome). Devolve os caminhos novos. */
  promoteDraftAttachments(convId: string, paths: string[]): Promise<string[]>
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
  /** Prints dos cartões (miniaturas): do projeto inteiro (`projectCwd`) ou de um cartão (`boardItemId`). Nada lança. */
  boardPrints(query: { projectCwd?: string; boardItemId?: string }): Promise<BoardPrintsResult>
  /** O print grande (no clique da miniatura). */
  boardPrintImage(id: string): Promise<BoardPrintImageResult>
  /** "Fala, PO": a conversa guardada do projeto. */
  poChatHistory(req: { projectCwd: string }): Promise<{ ok: true; messages: PoChatMessage[] } | { ok: false; message: string }>
  /** "Fala, PO": pergunta e devolve a conversa inteira (com a resposta). Nada lança. */
  poChatAsk(req: { projectCwd: string; question: string }): Promise<{ ok: true; messages: PoChatMessage[] } | { ok: false; message: string }>
  /** "Verificar de verdade" a resposta `messageId` (minutos; resolve no fim). */
  poChatVerify(req: { projectCwd: string; messageId: string }): Promise<{ ok: true; messages: PoChatMessage[] } | { ok: false; message: string }>
  poChatCancel(req: { projectCwd: string }): Promise<{ ok: boolean }>
  /** Aplica a correção `index` da resposta verificada (só no clique). */
  poChatApply(req: { projectCwd: string; messageId: string; index: number }): Promise<{ ok: true; messages: PoChatMessage[] } | { ok: false; message: string }>
  /** "Mandar fazer" aprovado: vai para a conversa dona, ou para a nova (`conversationId`). */
  poChatSend(req: {
    projectCwd: string
    messageId: string
    index: number
    conversationId?: string
    conversationTitle?: string
  }): Promise<{ ok: true; messages: PoChatMessage[] } | { ok: false; message: string }>
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
  /** Os prompts de _handoff/ do planejamento, na ordem em que foram gravados,
   *  com os registros de _handoff/enviados.json. */
  planningListHandoffs(req: PlanningRef): Promise<PlanningResult<PlanningHandoffListDto>>
  /** Grava um prompt em _handoff/AAAA-MM-DD-NN.md; devolve o nome do arquivo novo.
   *  `etapas`: as do roteiro que o prompt cobre (vão para o .meta.json ao lado). */
  planningWriteHandoff(req: PlanningRef & { conteudo: string; etapas?: string[] }): Promise<PlanningResult<{ name: string }>>
  /** Grava no banco um envio por prompt (na_fila) e uma entrega por etapa declarada,
   *  com a estimativa do roteiro copiada. Nada lança: falha vem como `{ ok: false }`. */
  handoffRegister(req: HandoffRegisterRequest): Promise<HandoffRegisterResult>
  /** Envios de handoff com as entregas (sem filtro = todos os projetos). Nada lança. */
  handoffList(req?: HandoffListRequest): Promise<HandoffListResult>
  /** Correção manual de uma entrega (concluir/reabrir); o envio é reavaliado. Nada lança. */
  handoffCorrectEntrega(req: HandoffCorrectEntregaRequest): Promise<HandoffCorrectEntregaResult>
  /** Fila do quadro: espera o quadro e o acompanhamento assentarem e diz se o próximo prompt sai. Nada lança. */
  handoffQueueGate(req: HandoffQueueGateRequest): Promise<HandoffQueueGateResult>
  /** Fila do quadro: marca pelo id o envio que o despachante vai mandar. Nada lança. */
  handoffQueueDispatched(req: HandoffQueueDispatchedRequest): Promise<HandoffQueueDispatchedResult>
  /** Fila do quadro: os prompts que esperam, com estado e motivo (faixa "Próximos prompts"). Nada lança. */
  handoffQueueList(req?: HandoffQueueListRequest): Promise<HandoffQueueListResult>
  /** Fila do projeto: a foto de todas as pastas deste PC. Nada lança. */
  handoffProjectStatus(): Promise<HandoffProjectStatusResult>
  /** Fila do projeto: a ação do usuário (o usuário vence sempre). Nada lança. */
  handoffProjectAction(req: HandoffProjectActionRequest): Promise<HandoffProjectActionResult>
  /** Fila do projeto: guarda a resposta do usuário no A com outro plano na vez; o PO decide. Nada lança. */
  handoffProjectReply(req: HandoffProjectReplyRequest): Promise<HandoffProjectReplyResult>
  /** A foto nova da fila do projeto. */
  onHandoffProjectChanged(cb: (snapshot: HandoffProjectSnapshot) => void): () => void
  /** Faixa "Próximos prompts": tirar da fila ou editar o texto. Nada lança. */
  handoffQueueEdit(req: HandoffQueueEditRequest): Promise<HandoffQueueEditResult>
  /** Faixa: reordena os prompts de um plano. Nada lança. */
  handoffQueueReorder(req: HandoffQueueReorderRequest): Promise<HandoffQueueEditResult>
  /** Faixa: reordena os planos de uma pasta. Nada lança. */
  handoffProjectReorder(req: HandoffProjectReorderRequest): Promise<HandoffQueueEditResult>
  /** Faixa: o que a pasta do plano tem sem commit. Nada lança. */
  handoffProjectDirty(req: { conversationId: string }): Promise<HandoffProjectDirtyResult>
  /** As autorizações do PO (commit/push), por conversa. Nada lança. */
  poAuthorizationList(): Promise<PoAuthorizationListResult>
  /** O "Revogar" do chip. Nada lança. */
  poAuthorizationRevoke(req: { conversationId: string }): Promise<{ ok: true } | { ok: false; message: string }>
  /** A foto nova das autorizações. */
  onPoAuthorizationsChanged(cb: (map: PoAuthorizationMap) => void): () => void
  /** O acompanhamento gravou algo nos envios de uma conversa — releia. */
  onHandoffChanged(cb: (msg: HandoffChangedMsg) => void): () => void
  /** Registra prompts como enviados/substituídos/marcados em _handoff/enviados.json;
   *  devolve todos os registros depois da gravação. */
  planningMarkHandoffsSent(
    req: PlanningRef & { entries: PlanningHandoffSentMark[] }
  ): Promise<PlanningResult<{ sent: PlanningHandoffSentDto[] }>>
  /** Move os prompts ANTIGOS não enviados para _handoff/_descartados/ (todos, ou só
   *  `names`); devolve os movidos. Prompt enviado nunca sai. Só depois de perguntar. */
  planningDiscardHandoffs(req: PlanningRef & { names?: string[] }): Promise<PlanningResult<{ discarded: string[] }>>
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
  /** Nome curto (claude-haiku-5-5, one-shot) para a conversa a partir da 1ª
   *  mensagem. Nunca lança: `ok: false` quando não houver título. */
  suggestConversationTitle(req: { text: string; convId?: string }): Promise<SuggestTitleResult>

  /** Transcribe recorded audio (base64 WAV/WebM) to text with the configured
   *  on-device engine. Model download progress arrives on onSpeechSetupProgress. */
  transcribeAudio(
    audioBase64: string,
    mimeType: string
  ): Promise<{ ok: boolean; text?: string; error?: string }>
  /** Synthesize speech (base64 WAV, local Kokoro) from already-treated text.
   *  Voice/speed come from the config unless overridden (Settings "Testar voz"). */
  speak(
    text: string,
    opts?: { voice?: string; speed?: number }
  ): Promise<{ ok: boolean; audioBase64?: string; mimeType?: string; error?: string }>
  /** Local Parakeet model and where it last ran ('GPU (DirectML)' / 'CPU'). */
  voiceStatus(): Promise<WhisperStatus>
  /** Install the local voice models now (same path as the first use). Progress
   *  arrives on onSpeechSetupProgress; a call during an install joins it. */
  voiceInstall(): Promise<{ ok: boolean; error?: string }>
  /** Are the local voice models installed / being installed? */
  voiceInstallStatus(): Promise<VoiceInstallStatus>
  /** Same, for one component (Kokoro TTS or Parakeet STT). */
  voiceComponentStatus(c: VoiceComponent): Promise<VoiceInstallStatus>
  /** Install one component now (Settings › Voz). Progress on onSpeechSetupProgress. */
  voiceComponentInstall(c: VoiceComponent): Promise<{ ok: boolean; error?: string }>
  /** Kokoro speaks a known phrase and the transcription model transcribes it back. */
  voiceTestTranscription(c: VoiceComponent): Promise<VoiceSelfTest>
  /** Android toolchain installed / missing / being installed (Settings › Android). */
  androidToolchainStatus(): Promise<AndroidToolchainStatus>
  /** Install the Android toolchain now. Lines on onAndroidToolchainProgress. */
  androidToolchainInstall(): Promise<{ ok: boolean; error?: string }>
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
  /** Raiz do modo sandbox. */
  sandboxInfo(): Promise<{ root: string }>
  /** Cria a subpasta de uma conversa de sandbox; erro de disco vem em `error`. */
  sandboxCreate(): Promise<SandboxCreateResult>
  /** Central: para onde vai a mensagem. Rejeita só com pedido inválido; falha do TypeSafe vira `ask` (`typesafe-failed`). */
  centralRoute(req: CentralRouteRequest): Promise<CentralRouteResult>
  /** Central: "não era aqui" — grava a correção no log local (calibração). Erro de disco não rejeita. */
  centralCorrection(c: CentralCorrection): Promise<void>
  /** Claude / GPT / Ollama conectados? (nunca lança: falha = false). */
  providersStatus(): Promise<ProvidersStatus>
  /** main → renderer: login, logout ou config de provedor mudou. */
  onProvidersChanged(cb: (status: ProvidersStatus) => void): () => void

  startAgent(opts: StartAgentOptions): Promise<{ ok: boolean; claudeAccountId?: string }>
  /** Fila de espera gravada no banco: tudo, no boot. */
  outboxList(): Promise<OutboxEntryDto[]>
  /** Regrava a fila de UMA conversa (lista vazia apaga). */
  outboxReplace(conversationId: string, items: Array<{ id: string; payload: unknown }>): Promise<{ ok: boolean }>
  /** Botão "agora": põe a mensagem da fila no turno em andamento, sem
   *  interromper. `ok: false` = não havia turno (ou era uma troca de conta): a
   *  mensagem continua na fila. `gone: true` = o item é de uma tarefa MCP que
   *  não está mais viva (regra 1): ele sai da fila, com aviso. */
  injectNow(
    convId: string,
    text: string,
    images?: ImageAttachment[],
    files?: FileAttachment[],
    fileRefs?: FileRefAttachment[],
    messageUuid?: string,
    /** Tarefa do MCP de entrada do item clicado; ausente = mensagem do usuário. */
    mcpTaskId?: string
  ): Promise<{ ok: boolean; reason?: string; gone?: boolean }>
  sendMessage(
    convId: string,
    text: string,
    images?: ImageAttachment[],
    files?: FileAttachment[],
    fileRefs?: FileRefAttachment[],
    /** Stable SDK uuid used to correlate an interrupt receipt with this bubble. */
    messageUuid?: string,
    /** Internal recovery prompts must not start a new loop activation. */
    messageKind?: AgentMessageKind,
    /** Tarefa do MCP de entrada que este envio leva (o item da fila, ou o reenvio
     *  dela); ausente = mensagem do usuário, que nunca herda nada de tarefa. */
    mcpTaskId?: string
  ): Promise<void>
  /** Resolve quando o turno em andamento da conversa acabou de fato no main
   *  (ocioso, handoff pronto, lease solto), sem sessão viva, ou no prazo máximo.
   *  A fila só manda o próximo item depois disto. Nunca rejeita. */
  waitTurnEnd(convId: string): Promise<TurnEndWait>
  /** `restart`: a troca silenciosa de sessão (config nova entre turnos) — não é o Stop do usuário. */
  interrupt(convId: string, opts?: { restart?: boolean }): Promise<AgentInterruptResult>
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
  /** Tempo somado dos turnos da conversa (leve: sem as chamadas de LLM). */
  getTurnTimeTotals(convId: string): Promise<TurnTimeTotals>
  /** Somente PC: cópias mascaradas do contexto entregue ao agente. */
  listContextTurns(convId: string): Promise<ContextTurnSummary[]>
  readContextTurn(convId: string, turnId: string, parentToolUseId?: string): Promise<ContextTurnDetail | null>
  countContextExact(convId: string): Promise<ContextExactCount>
  /** Ação explícita do olho: consulta o valor atual do cofre. */
  revealSecret(name: string): Promise<string | null>
  onContextTurnsChanged(cb: (event: ContextTurnChanged) => void): () => void
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
  /** One progress line of the Android toolchain install (androidToolchainInstall). */
  onAndroidToolchainProgress(cb: (line: string) => void): () => void

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
  /** MCP de entrada: uma tarefa para despachar (criando a conversa, se preciso). */
  onMcpInbound(cb: (m: McpInboundMsg) => void): () => void
  /** MCP de entrada: tirar da fila o item de uma tarefa cancelada. */
  onMcpCancelQueued(cb: (m: McpCancelQueuedMsg) => void): () => void
  /** MCP de entrada: o ouvinte está montado e as conversas carregadas. */
  mcpRendererReady(): Promise<void>
  /** MCP de entrada: a tarefa não chegou à conversa (erro curto e legível) ou,
   *  com `cancelada`, saiu da fila sem rodar (Stop da conversa, lixeira do item). */
  mcpTaskFailed(taskId: string, erro: string, cancelada?: boolean): Promise<void>
  /** A phone toggled the global "Permitir tudo" switch — apply it on the PC. */
  onRemoteSetSkipPerms(cb: (m: { on: boolean }) => void): () => void
  /** A phone asked to change a conversation's model/effort — apply it on the PC. */
  onRemoteSetModel(cb: (m: RemoteSetModelMsg) => void): () => void
  onRemoteRecoveryAction(cb: (m: { convId: string; action: 'retry' | 'cancel' }) => void): () => void
  /** A phone answered a pending permission/question — resolve it locally too. */
  onRemotePermissionResponse(cb: (m: RemotePermissionResponseMsg) => void): () => void
  /** A phone picked a "Para onde vai?" option of a Central request (the App calls `choose`). */
  onRemoteCentralChoose(cb: (m: RemoteCentralChoose) => void): () => void
  /** A phone asked to stop the running turn of a conversation. */
  onRemoteInterrupt(cb: (m: { convId: string }) => void): () => void
  /** A phone toggled a per-conversation mode (fast). */
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
