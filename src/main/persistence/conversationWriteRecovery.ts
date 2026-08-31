import {
  StorageError,
  type ConversationWrite,
  type PersistenceRepository,
  type VersionedConversation
} from './types'

type ConversationWriter = Pick<PersistenceRepository, 'loadConversations' | 'upsertConversation'>

const IPC_STORAGE_ERROR = 'agent-code-storage-error'

/** A valid lease guarantees that this installation is the sole writer for the
 * conversation. A stale renderer revision can therefore be rebased once onto
 * the authoritative row without overwriting another device's active turn. */
export async function upsertConversationWithLeaseRecovery(
  repository: ConversationWriter,
  write: ConversationWrite
): Promise<VersionedConversation> {
  try {
    return await repository.upsertConversation(write)
  } catch (cause) {
    if (!(cause instanceof StorageError) || cause.code !== 'REVISION_CONFLICT' || !write.lease) throw cause
    const current = (await repository.loadConversations({ includeDeleted: true }))
      .find((entry) => entry.id === write.id)
    if (!current) throw cause
    return repository.upsertConversation({ ...write, expectedRevision: current.revision })
  }
}

/** Electron keeps only name/message when an IPC handler rejects. Encode the
 * safe storage metadata in the message so the renderer can explain the failure
 * without exposing a pg connection string or driver internals. */
export function storageErrorForIpc(cause: unknown): Error {
  if (cause instanceof StorageError) {
    const error = new Error(
      `[${IPC_STORAGE_ERROR}:${cause.code}:${cause.retryable ? 'retryable' : 'fatal'}] ${cause.message}`
    )
    error.name = 'StorageError'
    return error
  }
  const error = new Error('A persistência rejeitou a gravação por uma falha inesperada.')
  error.name = 'StorageError'
  return error
}
