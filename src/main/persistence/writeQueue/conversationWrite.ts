import { CENTRAL_ID } from '../../../shared/central'
import { mergeCentralConversation, normalizeCentralState } from '../../../shared/centralMerge'
import { attachProjectIdentity, isMissingProjectFolderError, preserveProjectIdentityForMissingPersistedWrite, type ProjectIdentity } from '../projectIdentity'
import type { LeaseRenewal } from '../conversationWriteRecovery'
import {
  StorageError,
  type ConversationRecord,
  type LeaseFence,
  type PersistenceRepository,
  type VersionedConversation
} from '../types'
import type { ConversationPreparer } from './preparer'

/** O que a fila sabe da linha no banco: a base do próximo compare-and-set. */
export interface KnownRecord {
  revision: number
  contentHash: string
  /** Hash do estado do dispositivo na última gravação daqui (ausente: desconhecido). */
  deviceHash?: string
  deleted: boolean
  /** Só da Central: o payload da revisão conhecida, base da mescla por dono. */
  central?: ConversationRecord
}

export interface WriteContext {
  repository: PersistenceRepository
  preparer: ConversationPreparer
  /** Lease da sessão viva desta conversa (fencing), com a renovação de quando ele vence na queda. */
  lease?: { fence: LeaseFence; renew?: LeaseRenewal }
  identity(cwd: string): Promise<ProjectIdentity>
  installationId: string | null
}

export type WriteOutcome = {
  kind: 'written' | 'unchanged' | 'deleted'
  known: KnownRecord
  /** Central relida num conflito: a tela mescla e mostra o que veio do outro PC. */
  centralRemote?: VersionedConversation
}

/** Conflitos de revisão que a gravação absorve: 1 rebase; a Central (gravada pelos dois PCs), 3. */
const MAX_REBASES = 1
const MAX_CENTRAL_REBASES = 3

export function knownFrom(record: VersionedConversation): KnownRecord {
  return {
    revision: record.revision,
    contentHash: record.contentHash,
    deleted: Boolean(record.deletedAt),
    ...(record.id === CENTRAL_ID ? { central: record.payload } : {})
  }
}

const codeOf = (error: unknown): string | undefined => (error instanceof StorageError ? error.code : undefined)

async function stored(repository: PersistenceRepository, id: string): Promise<VersionedConversation | undefined> {
  return (await repository.loadConversations({ ids: [id], includeDeleted: true })).find((entry) => entry.id === id)
}

async function renewed(ctx: WriteContext, refused: unknown): Promise<LeaseFence> {
  const fence = await ctx.lease?.renew?.().catch((error: unknown) => {
    throw error instanceof StorageError && error.retryable
      ? error
      : new StorageError('STORAGE_OFFLINE', 'Não foi possível renovar o lease da conversa agora.', true, { cause: error })
  })
  if (!fence) throw refused
  return fence
}

/** Identidade do projeto; pasta que sumiu vale a já gravada, se for a mesma pasta. */
async function withIdentity(ctx: WriteContext, doc: ConversationRecord): Promise<ConversationRecord> {
  try {
    return await attachProjectIdentity(doc, ctx.identity)
  } catch (cause) {
    if (!isMissingProjectFolderError(cause)) throw cause
    return preserveProjectIdentityForMissingPersistedWrite(doc, (await stored(ctx.repository, String(doc.id)))?.payload)
  }
}

/** A Central daqui mesclada por dono com a de outro PC: as entradas deste PC vêm de
 *  `doc`, as dos outros, de `remote` (ver shared/centralMerge.ts). */
export function mergeCentralPayload(doc: ConversationRecord, remote: ConversationRecord, self: string | null): ConversationRecord {
  const updatedAt = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN)
  const theirs = { updatedAt: updatedAt(remote.updatedAt), central: normalizeCentralState(remote.central) }
  const local = { ...doc, updatedAt: updatedAt(doc.updatedAt), central: normalizeCentralState(doc.central) }
  const merged = mergeCentralConversation(local, theirs, self)
  return merged === local ? doc : merged
}

/** A Central vai mesclada por dono com a revisão que ela espera: o CAS garante a base. */
function centralPayload(doc: ConversationRecord, base: KnownRecord | undefined, self: string | null): ConversationRecord {
  if (doc.id !== CENTRAL_ID || !base?.central) return doc
  return mergeCentralPayload(doc, base.central, self)
}

/**
 * Grava o documento: prepara no worker, pula se o banco já tem exatamente isto e
 * faz o compare-and-set. Revisão que andou (outro writer, ou base desconhecida) é
 * rebaseada — o que está na tela vence, como sempre foi. Lease vencido na queda é
 * renovado uma vez, só se ainda for desta instalação.
 */
export async function writeConversationDoc(
  ctx: WriteContext,
  doc: ConversationRecord,
  known: KnownRecord | undefined
): Promise<WriteOutcome> {
  const id = String(doc.id)
  const identified = await withIdentity(ctx, doc)
  const scope = ctx.repository.conversationHashScope
  let base = known
  let lease = ctx.lease?.fence
  let leaseRenewed = false
  let centralRemote: VersionedConversation | undefined
  for (let rebases = 0; ; ) {
    const payload = centralPayload(identified, base, ctx.installationId)
    const prepared = await ctx.preparer.prepare(payload, scope)
    if (base && !base.deleted && base.contentHash === prepared.contentHash && base.deviceHash === prepared.deviceHash) {
      return { kind: 'unchanged', known: base, ...(centralRemote ? { centralRemote } : {}) }
    }
    try {
      const result = await ctx.repository.writeConversation({
        id,
        prepared,
        // Tombstone conhecido também é base: gravar de novo a conversa a desapaga.
        ...(base ? { expectedRevision: base.revision } : {}),
        ...(lease ? { lease } : {})
      })
      return {
        kind: 'written',
        known: {
          revision: result.revision,
          contentHash: result.contentHash,
          deviceHash: prepared.deviceHash,
          deleted: false,
          ...(id === CENTRAL_ID ? { central: JSON.parse(prepared.payloadJson) as ConversationRecord } : {})
        },
        ...(centralRemote ? { centralRemote } : {})
      }
    } catch (error) {
      if (codeOf(error) === 'LEASE_HELD_BY_OTHER_DEVICE' && lease && ctx.lease?.renew && !leaseRenewed) {
        lease = await renewed(ctx, error)
        leaseRenewed = true
        continue
      }
      if (codeOf(error) !== 'REVISION_CONFLICT' || rebases >= (id === CENTRAL_ID ? MAX_CENTRAL_REBASES : MAX_REBASES)) throw error
      rebases += 1
      const current = await stored(ctx.repository, id)
      base = current ? knownFrom(current) : undefined
      if (current && id === CENTRAL_ID) centralRemote = current
    }
  }
}

/** Tombstone com compare-and-set; conversa que já sumiu do banco não precisa de nada. */
export async function deleteConversationDoc(
  ctx: WriteContext,
  id: string,
  known: KnownRecord | undefined
): Promise<WriteOutcome> {
  let base = known
  let lease = ctx.lease?.fence
  let leaseRenewed = false
  for (let attempt = 0; ; ) {
    if (!base) {
      const current = await stored(ctx.repository, id)
      if (!current) return { kind: 'deleted', known: { revision: 0, contentHash: '', deleted: true } }
      base = knownFrom(current)
    }
    if (base.deleted) return { kind: 'deleted', known: base }
    try {
      const result = await ctx.repository.deleteConversation({ id, expectedRevision: base.revision, ...(lease ? { lease } : {}) })
      return { kind: 'deleted', known: { revision: result.revision, contentHash: result.contentHash, deleted: true } }
    } catch (error) {
      if (codeOf(error) === 'LEASE_HELD_BY_OTHER_DEVICE' && lease && ctx.lease?.renew && !leaseRenewed) {
        lease = await renewed(ctx, error)
        leaseRenewed = true
        continue
      }
      if (codeOf(error) !== 'REVISION_CONFLICT' || attempt >= MAX_REBASES) throw error
      attempt += 1
      base = undefined
    }
  }
}
