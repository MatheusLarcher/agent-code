import type { SessionStore } from '@anthropic-ai/claude-agent-sdk'
import type { AppConfig } from '../../shared/ipc'

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

export type RepositoryChangeEntity = 'global-kv' | 'device-kv' | 'conversation' | 'lease' | 'project'

export interface RepositoryChange {
  changeId: string
  entity: RepositoryChangeEntity
  entityId: string
  revision?: number
  installationId?: string
}

export type RepositoryChangeHandler = (changes: RepositoryChange[]) => void

export interface PersistenceRepository {
  readonly backend: StorageBackend

  initialize(): Promise<void>
  close(): Promise<void>

  loadSnapshot(): Promise<ApplicationSnapshot>
  getKv(address: KvAddress): Promise<VersionedKv | null>
  setKv(write: KvWrite): Promise<VersionedKv>

  loadConversations(options?: { includeDeleted?: boolean }): Promise<VersionedConversation[]>
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
