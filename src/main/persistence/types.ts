import type { SessionStore, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AppConfig, BoardItem, BoardItemEvent, BoardItemStatus } from '../../shared/ipc'

export type {
  BoardItem,
  BoardItemEvent,
  BoardItemEventActor,
  BoardItemEventKind,
  BoardItemOrigin,
  BoardItemStatus
} from '../../shared/ipc'
import type { TransferRecords } from './transferRecords'

export type StorageBackend = 'sqlite' | 'postgres'

export type StorageLifecycleState =
  | 'booting'
  | 'sqlite-ready'
  | 'testing-postgres'
  | 'activating-postgres'
  | 'postgres-ready'
  | 'postgres-offline'
  | 'deactivating-postgres'
  | 'fatal'

export type StorageErrorCode =
  | 'HOST_UNREACHABLE'
  | 'AUTHENTICATION_FAILED'
  | 'TLS_VERIFICATION_FAILED'
  | 'MAINTENANCE_DB_UNAVAILABLE'
  | 'CREATE_DATABASE_DENIED'
  | 'SCHEMA_CHECKSUM_MISMATCH'
  | 'SCHEMA_TOO_NEW'
  | 'MIGRATION_VERIFICATION_FAILED'
  | 'STORAGE_OFFLINE'
  | 'LEASE_HELD_BY_OTHER_DEVICE'
  | 'SESSION_HANDOFF_INCOMPLETE'
  | 'SDK_SESSION_INCOMPATIBLE'
  | 'REVISION_CONFLICT'
  | 'INVALID_PERSISTED_DATA'
  | 'TRANSITION_IN_PROGRESS'
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_TIMEOUT'
  | 'DML_FAILED'
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'TASK_INVALID_TRANSITION'
  | 'TASK_FENCE_STALE'

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly retryable = false,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = 'StorageError'
  }
}

export interface StorageStatus {
  backend: StorageBackend
  state: StorageLifecycleState
  writable: boolean
  installationId: string
  targetDatabase: 'agent-code'
  hasPassword: boolean
  transitionStep?: string
  error?: {
    code: StorageErrorCode
    message: string
    retryable: boolean
  }
}

export type KvScope = 'global' | 'device'

export interface KvAddress {
  scope: KvScope
  key: string
}

export interface VersionedKv extends KvAddress {
  value: string
  revision: number
  contentHash: string
  updatedAt: string
}

export interface KvWrite extends KvAddress {
  value: string
  expectedRevision?: number
}

export type ConversationRecord = Record<string, unknown>

export interface VersionedConversation {
  id: string
  payload: ConversationRecord
  revision: number
  contentHash: string
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export interface ConversationWrite {
  id: string
  payload: ConversationRecord
  expectedRevision?: number
  lease?: LeaseFence
}

export interface ConversationDelete {
  id: string
  expectedRevision: number
  lease?: LeaseFence
}

export interface LeaseFence {
  token: string
  fencingEpoch: number
}

export interface ConversationLease extends LeaseFence {
  conversationId: string
  ownerInstallationId: string
  expiresAt: string
}

export interface ApplicationSnapshot {
  backend: StorageBackend
  config: AppConfig
  kv: VersionedKv[]
  conversations: VersionedConversation[]
  watermark: string
}

export interface ExportSnapshot {
  backend: StorageBackend
  conversations: ConversationRecord[]
  watermark: string
}

export type RepositoryChangeEntity =
  | 'global-kv'
  | 'device-kv'
  | 'conversation'
  | 'lease'
  | 'project'
  | 'task'
  | 'memory'
  | 'board'

export interface RepositoryChange {
  changeId: string
  entity: RepositoryChangeEntity
  entityId: string
  revision?: number
  installationId?: string
}

export type RepositoryChangeHandler = (changes: RepositoryChange[]) => void

/** See `ConversationQueryDto` in shared/ipc.ts — same shape, main-side. `perProject`,
 *  `cwd` and `cwds` rank/filter LIVE conversations only (a tombstone must not occupy
 *  one of the N visible slots); `ids` honours `includeDeleted`. */
export interface ConversationQuery {
  includeDeleted?: boolean
  perProject?: number
  cwd?: string
  /** Restrict to these project folders. Combined with `perProject`, this is how the
   *  app opens: the first handful of projects come down, the rest follow em segundo
   *  plano. Empty array means "nenhum projeto" and returns nothing. */
  cwds?: string[]
  ids?: string[]
}

export interface ProjectConversationCount {
  cwd: string
  total: number
  /** Newest `updated_at` among the project's live conversations (ISO 8601). Lets the
   *  app order projects — and decide which ones to load first — without reading a
   *  single conversation payload. */
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Task ledger (tasks / task_steps / task_deliverables / task_events)
// ---------------------------------------------------------------------------

export type TaskStatus = 'pending' | 'running' | 'blocked' | 'review' | 'done' | 'failed' | 'cancelled'
export type StepKind = 'analyze' | 'implement' | 'verify' | 'review' | 'handoff'
export type DeliverableKind = 'diff' | 'test_run' | 'note' | 'file' | 'screenshot'

/** Globs relative to `projectCwd` the task's writer may (and may not) touch. */
export interface WriteScope {
  allow: string[]
  deny: string[]
}

export interface Task {
  id: string
  conversationId: string | null
  projectCwd: string
  title: string
  goal: string
  acceptance: string[]
  status: TaskStatus
  ownerAgent: string | null
  writeScope: WriteScope
  parentTaskId: string | null
  attempts: number
  maxAttempts: number
  leaseToken: string | null
  leaseExpiresAt: string | null
  fencingEpoch: number
  revision: number
  createdAt: string
  updatedAt: string
}

export interface TaskStep {
  id: string
  taskId: string
  seq: number
  kind: StepKind
  status: TaskStatus
  agent: string | null
  sdkSessionId: string | null
  startedAt: string
  finishedAt: string | null
  error: Record<string, unknown> | null
  revision: number
  createdAt: string
  updatedAt: string
}

export interface TaskDeliverable {
  id: string
  taskId: string
  stepId: string | null
  kind: DeliverableKind
  summary: string
  payloadPath: string | null
  payloadHash: string | null
  verified: boolean
  verifiedBy: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

export interface TaskEvent {
  id: string
  taskId: string
  stepId: string | null
  at: string
  kind: string
  data: Record<string, unknown>
}

export interface TaskCreate {
  id?: string
  conversationId?: string | null
  projectCwd: string
  title: string
  goal: string
  acceptance?: string[]
  writeScope?: Partial<WriteScope>
  parentTaskId?: string | null
  maxAttempts?: number
}

/** A claim is a lease on a `pending` task: token + epoch fence every later write. */
export interface TaskClaim extends LeaseFence {
  task: Task
  expiresAt: string
}

export interface TaskTransition {
  taskId: string
  from: TaskStatus
  to: TaskStatus
  /** Required while a live lease exists; must match token + epoch (`TASK_FENCE_STALE`). */
  fence?: LeaseFence
  agent?: string
  reason?: string
}

export interface TaskStepAppend {
  taskId: string
  kind: StepKind
  agent?: string | null
  sdkSessionId?: string | null
  fence?: LeaseFence
}

export interface TaskStepFinish {
  stepId: string
  status: Exclude<TaskStatus, 'pending' | 'running'>
  error?: Record<string, unknown> | null
  fence?: LeaseFence
}

export interface TaskDeliverableAdd {
  taskId: string
  stepId?: string | null
  kind: DeliverableKind
  summary: string
  payloadPath?: string | null
  payloadHash?: string | null
  verified?: boolean
  verifiedBy?: string | null
  fence?: LeaseFence
}

export interface TaskEventAppend {
  taskId: string
  stepId?: string | null
  kind: string
  data?: Record<string, unknown>
}

export interface TaskQuery {
  status?: TaskStatus | TaskStatus[]
  projectCwd?: string
  /**
   * Todos os caminhos que são o MESMO projeto (este PC + os outros que já
   * gravaram a identidade). Vence `projectCwd` quando presente: é o que faz a
   * fila do projeto ser uma só num PostgreSQL compartilhado, em vez de uma por
   * máquina. Lista vazia significa "nenhum projeto" e não devolve nada.
   */
  projectCwds?: string[]
  conversationId?: string
  parentTaskId?: string | null
  ids?: string[]
  limit?: number
}

/** Caminho local ↔ identidade estável do projeto (git remote + commit raiz). */
export interface ProjectIdentityRow {
  projectCwd: string
  projectId: string
  signature: string
  updatedAt: string
}

/**
 * Vínculo entre uma tarefa do ledger e um cartão do quadro. `taskId` é a
 * chave — uma tarefa aponta para no máximo um cartão — então vincular de novo
 * é upsert: reescreve o cartão de destino, não é rejeitado. É o mesmo
 * comportamento de `recordProjectIdentity`, e evita que um vínculo obsoleto
 * (ex.: o executor recriou o cartão) trave a tarefa para sempre.
 */
export interface TaskBoardLink {
  taskId: string
  boardItemId: string
  linkedBy: 'agent' | 'po'
  createdAt: string
}

export interface TaskBoardLinkWrite {
  taskId: string
  boardItemId: string
  linkedBy: 'agent' | 'po'
}

/**
 * Narrows what a claim may pick. Without it the oldest `pending` task of ANY
 * project would be handed out — a supervisor in project A would silently take
 * work meant for project B.
 */
export interface TaskClaimFilter {
  projectCwd?: string
  /** Como em `TaskQuery`: os caminhos equivalentes do mesmo projeto. Vence `projectCwd`. */
  projectCwds?: string[]
  taskId?: string
}

export interface TaskRepository {
  createTask(input: TaskCreate): Promise<Task>
  /** Oldest `pending` task (within `filter`) without a live lease, or `null`. Atomic: two claimants never share a task. */
  claimTask(agentId: string, filter?: TaskClaimFilter): Promise<TaskClaim | null>
  renewTaskLease(taskId: string, fence: LeaseFence): Promise<TaskClaim>
  transitionTask(input: TaskTransition): Promise<Task>
  appendTaskStep(input: TaskStepAppend): Promise<TaskStep>
  finishTaskStep(input: TaskStepFinish): Promise<TaskStep>
  addTaskDeliverable(input: TaskDeliverableAdd): Promise<TaskDeliverable>
  appendTaskEvent(input: TaskEventAppend): Promise<TaskEvent>
  /** Registra (upsert) o caminho local deste PC sob a identidade estável do projeto. */
  recordProjectIdentity(row: Omit<ProjectIdentityRow, 'updatedAt'>): Promise<void>
  /** Todos os caminhos locais já registrados sob a mesma identidade, em qualquer PC. */
  projectCwdsForIdentity(projectId: string): Promise<string[]>
  /** Vincula (upsert) uma tarefa do ledger a um cartão do quadro. */
  linkTaskToBoardItem(input: TaskBoardLinkWrite): Promise<void>
  /** `task_id -> board_item_id` para as tarefas informadas que têm vínculo; as
   *  sem vínculo simplesmente não aparecem no mapa. Uma query só, nunca N+1. */
  boardItemIdsForTasks(taskIds: string[]): Promise<Map<string, string>>
  getTask(taskId: string): Promise<Task | null>
  listTasks(query?: TaskQuery): Promise<Task[]>
  listTaskSteps(taskId: string): Promise<TaskStep[]>
  listTaskDeliverables(taskId: string): Promise<TaskDeliverable[]>
  listTaskEvents(taskId: string): Promise<TaskEvent[]>
}

// ---------------------------------------------------------------------------
// Quadro de tarefas do agente (board_items)
// ---------------------------------------------------------------------------

/** Um cartão do snapshot do CLI, já resolvido para o formato do quadro. */
export interface BoardSourceItem {
  sourceId: string
  title: string
  status: BoardItemStatus
  activeForm: string | null
  seq: number
}

/**
 * O snapshot inteiro de UMA conversa. É substituição, não incremento: o CLI
 * reescreve a lista toda, então o que sumiu do snapshot sumiu de verdade.
 *
 * Um cuidado que a implementação precisa honrar: snapshot vazio **não** apaga
 * o quadro. "Esta sessão nunca usou tarefas" e "o plano agora está vazio" são
 * indistinguíveis na leitura, e tratar o primeiro como o segundo torraria o
 * quadro inteiro de uma conversa por causa de uma leitura sem sorte.
 */
export interface BoardSyncInput {
  projectId: string
  projectCwd: string
  conversationId: string
  items: BoardSourceItem[]
}

/** Escrita do PO. Só os campos dele; `undefined` deixa como está, `null` limpa. */
export interface BoardPoWrite {
  id: string
  poTitle?: string | null
  poNote?: string | null
  poStatus?: BoardItemStatus | null
  /** Obrigatório quando `poStatus` muda: é o que aparece na trilha do cartão. */
  poReason?: string | null
  /** Quem fez a escrita, para o evento do histórico. Padrão `'po'` quando
   *  omitido — preserva quem já chama sem este campo. O drag-and-drop do
   *  usuário passa `'user'`: é um terceiro tipo de escritor, distinto do PO. */
  actor?: 'po' | 'user'
}

/** Cartão que o agente nunca declarou, criado pelo PO. */
export interface BoardPoCreate {
  projectId: string
  projectCwd: string
  conversationId: string
  title: string
  status: BoardItemStatus
  reason: string
}

export interface BoardQuery {
  /** Caminhos equivalentes do MESMO projeto. Lista vazia = nenhum projeto. */
  projectIds: string[]
  conversationId?: string
  includeDismissed?: boolean
}

export interface BoardRepository {
  /** Aplica o snapshot de uma conversa preservando os campos do PO. */
  syncBoardItems(input: BoardSyncInput): Promise<BoardItem[]>
  listBoardItems(query: BoardQuery): Promise<BoardItem[]>
  /** Um cartão pelo id, ou `null` se não existir. Usado pelo drag-and-drop
   *  para decidir a ação (enviar/interromper) a partir do status ATUAL, antes
   *  de escrever — sem repetir a busca por (projectId, conversationId) que
   *  `listBoardItems` exige. */
  getBoardItem(id: string): Promise<BoardItem | null>
  applyBoardPo(input: BoardPoWrite): Promise<BoardItem>
  createBoardPoItem(input: BoardPoCreate): Promise<BoardItem>
  dismissBoardItem(id: string, dismissed: boolean): Promise<BoardItem>
  /** A linha do tempo de um cartão, em ordem cronológica. */
  listBoardItemEvents(boardItemId: string): Promise<BoardItemEvent[]>
}

// ---------------------------------------------------------------------------
// Memory service (memory_entries / memory_proposals)
// ---------------------------------------------------------------------------

export type MemoryScope = 'user' | 'project' | 'domain'
export type MemoryEntryStatus = 'active' | 'retired'
export type MemoryProposalOp = 'create' | 'update' | 'retire'
export type MemoryProposalStatus = 'pending' | 'applied' | 'rejected' | 'conflict'

export interface MemoryOrigin {
  originConversationId: string | null
  originMessageId: string | null
  originAgent: string | null
}

/** One Markdown memory. The database row is the source; the file under
 *  `memories/<relPath>` and the bullet in `MEMORY.md` are projections. */
export interface MemoryEntry extends MemoryOrigin {
  id: string
  relPath: string
  title: string
  hook: string
  scope: MemoryScope
  projectCwd: string | null
  domain: string | null
  body: string
  bodyHash: string
  revision: number
  status: MemoryEntryStatus
  supersedesId: string | null
  createdAt: string
  updatedAt: string
}

/** Keyed by `relPath`. `expectedRevision` 0 inserts; otherwise it is a CAS on
 *  the current revision (`REVISION_CONFLICT` when it moved). */
export interface MemoryEntryWrite extends Partial<MemoryOrigin> {
  relPath: string
  title: string
  hook: string
  scope: MemoryScope
  projectCwd?: string | null
  domain?: string | null
  body: string
  status: MemoryEntryStatus
  supersedesId?: string | null
  expectedRevision: number
}

export interface MemoryProposal extends MemoryOrigin {
  id: string
  entryId: string | null
  op: MemoryProposalOp
  relPath: string
  title: string | null
  hook: string | null
  body: string | null
  scope: MemoryScope
  projectCwd: string | null
  domain: string | null
  status: MemoryProposalStatus
  reason: string | null
  proposedBy: string
  expectedRevision: number | null
  attempts: number
  leaseToken: string | null
  leaseExpiresAt: string | null
  createdAt: string
  updatedAt: string
}

/** Already validated by `MemoryService.propose`; the repository only stores it. */
export interface MemoryProposalCreate extends Partial<MemoryOrigin> {
  id?: string
  op: MemoryProposalOp
  relPath: string
  title?: string | null
  hook?: string | null
  body?: string | null
  scope: MemoryScope
  projectCwd?: string | null
  domain?: string | null
  proposedBy: string
  expectedRevision?: number | null
}

export interface MemoryProposalClaim {
  proposal: MemoryProposal
  token: string
  expiresAt: string
}

export type MemoryProposalSettle =
  | { proposalId: string; token: string; outcome: 'applied'; entry: MemoryEntryWrite }
  | { proposalId: string; token: string; outcome: 'conflict' | 'rejected'; reason: string }
  /** Back to `pending` (transient failure); the lease is released. */
  | { proposalId: string; token: string; outcome: 'requeue'; reason: string }

export interface MemoryProposalQuery {
  status?: MemoryProposalStatus | MemoryProposalStatus[]
  limit?: number
}

export interface MemoryRepository {
  listMemoryEntries(query?: { status?: MemoryEntryStatus }): Promise<MemoryEntry[]>
  getMemoryEntryByPath(relPath: string): Promise<MemoryEntry | null>
  writeMemoryEntry(write: MemoryEntryWrite): Promise<MemoryEntry>
  enqueueMemoryProposal(input: MemoryProposalCreate): Promise<MemoryProposal>
  /** Oldest `pending` proposal without a live lease, leased to the caller; `null` when none. Increments `attempts`. */
  claimMemoryProposal(): Promise<MemoryProposalClaim | null>
  /** Finishes a claimed proposal. Applied requires a matching entry CAS; write and settlement commit atomically. */
  settleMemoryProposal(input: MemoryProposalSettle): Promise<MemoryProposal>
  listMemoryProposals(query?: MemoryProposalQuery): Promise<MemoryProposal[]>
  /** Removes a settled (`conflict`/`rejected`) proposal row. Returns false when it does not exist.
   * Never touches the referenced entry; `pending`/`applied` proposals are refused. */
  deleteMemoryProposal(id: string): Promise<boolean>
}

// ---------------------------------------------------------------------------
// Árvore de consumo de tokens por chamada de LLM (llm_calls / llm_usage_totals)
// ---------------------------------------------------------------------------

/** Uma chamada real ao modelo — uma linha por mensagem `assistant` do stream,
 *  atribuída ao nó da árvore de delegação (`nodeId`) que a originou. Ver
 *  docs/superpowers/specs/2026-09-19-arvore-consumo-tokens-design.md. */
export interface LlmCall {
  id: string
  convId: string
  /** Nasce quando o usuário envia uma mensagem; é o `nodeId` do nó-raiz do turno. */
  turnId: string
  /** `id` do tool-use que abriu este nó (subagente), ou `turnId` na raiz. */
  nodeId: string
  /** `null` na raiz (delegou o agente principal); `nodeId` de outro nó quando
   *  quem delegou foi um subagente — dá profundidade arbitrária à árvore. */
  parentNodeId: string | null
  subagentType: string | null
  taskDescription: string | null
  /** Ordem desta chamada dentro do nó (um subagente troca várias mensagens). */
  seq: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** `null` quando não há tabela de preço confiável para o modelo — nunca estimado. */
  costUsd: number | null
  inputPreview: string | null
  outputPreview: string | null
  createdAt: string
}

export interface LlmCallInsert {
  id?: string
  convId: string
  turnId: string
  nodeId: string
  parentNodeId?: string | null
  subagentType?: string | null
  taskDescription?: string | null
  seq: number
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number | null
  inputPreview?: string | null
  outputPreview?: string | null
}

/** Replacement values for usage initially unavailable on streamed assistant messages. */
export interface LlmCallUsageUpdate {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number | null
}

/** Agregado incremental, atualizado (upsert) na mesma escrita de `insertLlmCall` —
 *  não depende da poda de 15 dias rodar para estar correto, e sobrevive a ela. */
export interface LlmUsageTotal {
  convId: string
  /** Data (UTC, `YYYY-MM-DD`) de `createdAt` da chamada agregada. */
  day: string
  model: string
  /** `null` agrega o agente principal (raiz), sem subagente. */
  subagentType: string | null
  sumInput: number
  sumOutput: number
  sumCacheRead: number
  sumCacheWrite: number
  sumCost: number | null
  callCount: number
}

export interface TokenUsageRepository {
  /** Grava a chamada e incrementa `llm_usage_totals` na mesma escrita (atômico). */
  insertLlmCall(input: LlmCallInsert): Promise<LlmCall>
  /** Replaces usage for an existing call and applies only the delta to totals. */
  updateLlmCall(id: string, usage: LlmCallUsageUpdate): Promise<LlmCall | null>
  /** Todas as chamadas de uma conversa, em ordem cronológica — para reconstruir a árvore. */
  listLlmCalls(convId: string): Promise<LlmCall[]>
  /** Os totais agregados de uma conversa (sobrevivem à poda de `llm_calls`). */
  listLlmUsageTotals(convId: string): Promise<LlmUsageTotal[]>
}

export type AgentInputQueueStatus = 'pending' | 'processing'

export interface AgentInputQueueItem {
  id: number
  conversationId: string
  messageUuid: string
  message: SDKUserMessage
  sequence: number
  status: AgentInputQueueStatus
  attemptCount: number
  availableAt: string
  processingStartedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentInputQueueRepository {
  enqueueAgentInput(conversationId: string, message: SDKUserMessage, messageUuid?: string): Promise<AgentInputQueueItem>
  claimNextAgentInput(conversationId: string): Promise<AgentInputQueueItem | null>
  completeAgentInput(id: number): Promise<void>
  requeueAgentInput(id: number, error?: string): Promise<void>
  recoverAgentInput(conversationId?: string): Promise<number>
  listAgentInputs(conversationId: string): Promise<AgentInputQueueItem[]>
}

/** Um item da fila de espera de uma conversa. `payload` é o item do renderer
 *  (texto, anexos), opaco para o main. */
export interface ConversationOutboxItem {
  conversationId: string
  id: string
  payload: unknown
}

export interface ConversationOutboxRepository {
  /** Todas as filas, por conversa e na ordem de envio. */
  listConversationOutbox(): Promise<ConversationOutboxItem[]>
  /** Troca a fila inteira de UMA conversa (vazia = apaga). */
  replaceConversationOutbox(conversationId: string, items: ReadonlyArray<{ id: string; payload: unknown }>): Promise<void>
}

export interface PersistenceRepository
  extends TaskRepository,
    MemoryRepository,
    BoardRepository,
    TokenUsageRepository,
    AgentInputQueueRepository,
    ConversationOutboxRepository {
  readonly backend: StorageBackend

  initialize(): Promise<void>
  close(): Promise<void>

  loadSnapshot(): Promise<ApplicationSnapshot>
  /** "Dá para ler este backend?" — sonda LIMITADA, para abrir um backend que já
   * está confirmado. Toca as mesmas tabelas que o app usa (KV + conversas) sem
   * baixar nenhum payload. A releitura completa do `loadSnapshot()` continua
   * sendo obrigatória nas TRANSIÇÕES de backend, onde o que se verifica é que os
   * dados importados voltam inteiros — aqui não há importação para verificar, e
   * com PostgreSQL remoto essa leitura custava dezenas de MB antes da janela. */
  verifyReadable(): Promise<void>
  /** Full task/memory export, including history and retired entries. Atomic;
   * rejects live leases and strips expired tokens using the source DB clock. */
  loadTransferRecords(): Promise<TransferRecords>
  getKv(address: KvAddress): Promise<VersionedKv | null>
  /** Várias chaves do MESMO escopo em uma consulta. Chave ausente simplesmente
   * não aparece no resultado. Existe pelo boot: a configuração tem uma dúzia de
   * campos e, um `getKv` por campo, cada um é uma ida e volta à rede. */
  getKvMany(scope: KvScope, keys: string[]): Promise<VersionedKv[]>
  setKv(write: KvWrite): Promise<VersionedKv>

  loadConversations(options?: ConversationQuery): Promise<VersionedConversation[]>
  /** Live (non-deleted) conversation count per project folder — the sidebar
   *  badge stays truthful while only the first page of each project is loaded. */
  countConversationsByProject(): Promise<ProjectConversationCount[]>
  upsertConversation(write: ConversationWrite): Promise<VersionedConversation>
  deleteConversation(input: ConversationDelete): Promise<VersionedConversation>
  /** Compatibility bridge for the current renderer; removed after per-record IPC lands. */
  replaceAllConversations(records: ConversationRecord[]): Promise<void>

  readExportSnapshot(): Promise<ExportSnapshot>
  createSessionStore(conversationId: string): SessionStore
  sessionResumeReady(conversationId: string, sessionId: string): Promise<boolean>
  markSessionResumeReady(conversationId: string, sessionId: string, ready: boolean, verifiedHash?: string): Promise<void>

  acquireConversationLease(conversationId: string): Promise<ConversationLease>
  renewConversationLease(lease: ConversationLease): Promise<ConversationLease>
  releaseConversationLease(lease: ConversationLease): Promise<void>

  subscribe(handler: RepositoryChangeHandler): () => void
}
