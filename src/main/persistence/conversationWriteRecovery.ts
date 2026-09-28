import {
  StorageError,
  type ConversationDelete,
  type ConversationWrite,
  type LeaseFence,
  type PersistenceRepository,
  type VersionedConversation
} from './types'

type ConversationWriter = Pick<PersistenceRepository, 'loadConversations' | 'upsertConversation'>
type ConversationDeleter = Pick<PersistenceRepository, 'deleteConversation'>
/** A instância, ou um resolvedor do repositório ATIVO: a repetição depois da
 *  renovação resolve de novo, porque uma reconexão durante a renovação troca o
 *  repositório (o anterior fica com o pool encerrado). */
type RepositorySource<T> = T | (() => T)
/** Renova o lease para repetir a gravação. `lease` = continua desta instalação;
 *  `null` = perdido (outro dispositivo, ou a sessão acabou): o erro original é
 *  terminal; rejeitar = falha transitória (banco instável): a gravação sai como
 *  erro de armazenamento repetível, não como "outro writer". */
export type LeaseRenewal = () => Promise<LeaseFence | null>

const IPC_STORAGE_ERROR = 'agent-code-storage-error'

function resolver<T extends object>(source: RepositorySource<T>): () => T {
  return typeof source === 'function' ? (source as () => T) : () => source
}

function isLeaseRefused(cause: unknown): cause is StorageError {
  return cause instanceof StorageError && cause.code === 'LEASE_HELD_BY_OTHER_DEVICE'
}

async function renewedLease(refused: StorageError, renewLease: LeaseRenewal): Promise<LeaseFence> {
  let renewed: LeaseFence | null
  try {
    renewed = await renewLease()
  } catch (error) {
    if (isLeaseRefused(error)) throw refused
    // Não dá para provar que o lease é de outro dispositivo: é o banco que não
    // respondeu. A conversa continua suja e é regravada quando o armazenamento
    // volta a aceitar escrita.
    throw error instanceof StorageError && error.retryable
      ? error
      : new StorageError('STORAGE_OFFLINE', 'Não foi possível renovar o lease da conversa agora.', true, { cause: error })
  }
  if (!renewed) throw refused
  return renewed
}

/** A valid lease guarantees that this installation is the sole writer for the
 * conversation. A stale renderer revision can therefore be rebased once onto
 * the authoritative row without overwriting another device's active turn. */
export async function upsertConversationWithLeaseRecovery(
  repository: RepositorySource<ConversationWriter>,
  write: ConversationWrite,
  renewLease?: LeaseRenewal
): Promise<VersionedConversation> {
  const current = resolver(repository)
  try {
    return await current().upsertConversation(write)
  } catch (cause) {
    // Logo depois de uma reconexão o lease pode ter vencido na queda sem que
    // ninguém o tenha tomado: o fence recusa (LEASE_HELD_BY_OTHER_DEVICE) até o
    // próximo heartbeat. Renovar só dá certo se o token ainda é nosso — então o
    // escritor único continua garantido e a gravação é repetida uma vez.
    if (isLeaseRefused(cause) && write.lease && renewLease) {
      const lease = await renewedLease(cause, renewLease)
      return upsertConversationWithLeaseRecovery(current, { ...write, lease })
    }
    if (!(cause instanceof StorageError) || cause.code !== 'REVISION_CONFLICT' || !write.lease) throw cause
    const stored = (await current().loadConversations({ includeDeleted: true }))
      .find((entry) => entry.id === write.id)
    if (!stored) throw cause
    return current().upsertConversation({ ...write, expectedRevision: stored.revision })
  }
}

/** Exclusão com fence: a mesma renovação e repetição única do upsert. */
export async function deleteConversationWithLeaseRecovery(
  repository: RepositorySource<ConversationDeleter>,
  input: ConversationDelete,
  renewLease?: LeaseRenewal
): Promise<VersionedConversation> {
  const current = resolver(repository)
  try {
    return await current().deleteConversation(input)
  } catch (cause) {
    if (!isLeaseRefused(cause) || !input.lease || !renewLease) throw cause
    const lease = await renewedLease(cause, renewLease)
    return current().deleteConversation({ ...input, lease })
  }
}

/** `LeaseRenewal` de uma sessão viva. `isCurrent` diz se o keeper ainda é o da
 *  conversa: o `onLost` (lease de outro dispositivo) e o fim da sessão o tiram
 *  do mapa, e aí o lease é dado como perdido. Falha com o keeper ainda no lugar
 *  é transitória (ele tenta de novo sozinho). */
export function sessionLeaseRenewal(
  keeper: { renewNow(): Promise<boolean>; readonly lease: LeaseFence },
  isCurrent: () => boolean
): LeaseRenewal {
  return async () => {
    const renewed = await keeper.renewNow()
    if (!isCurrent()) return null
    if (!renewed) throw new StorageError('STORAGE_OFFLINE', 'A renovação do lease falhou por instabilidade do banco.', true)
    return { token: keeper.lease.token, fencingEpoch: keeper.lease.fencingEpoch }
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
  console.error('[conversationWriteRecovery] Unexpected storage error:', cause instanceof Error ? cause.stack : String(cause))
  const error = new Error('A persistência rejeitou a gravação por uma falha inesperada.')
  error.name = 'StorageError'
  return error
}
