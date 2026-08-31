import { describe, expect, it, vi } from 'vitest'
import { StorageError, type ConversationWrite, type VersionedConversation } from './types'
import { storageErrorForIpc, upsertConversationWithLeaseRecovery } from './conversationWriteRecovery'

const write: ConversationWrite = {
  id: 'conversation',
  payload: { id: 'conversation', title: 'Resposta nova' },
  expectedRevision: 4,
  lease: { token: 'lease', fencingEpoch: 2 }
}

const stored: VersionedConversation = {
  id: 'conversation',
  payload: write.payload,
  revision: 6,
  contentHash: 'hash',
  createdAt: '2026-08-30T12:00:00.000Z',
  updatedAt: '2026-08-30T12:01:00.000Z'
}

describe('conversation write recovery', () => {
  it('rebases one stale active-conversation write onto the authoritative revision', async () => {
    const upsertConversation = vi.fn()
      .mockRejectedValueOnce(new StorageError('REVISION_CONFLICT', 'Conversa foi alterada.'))
      .mockResolvedValueOnce(stored)
    const loadConversations = vi.fn().mockResolvedValue([{ ...stored, revision: 5 }])

    await expect(upsertConversationWithLeaseRecovery({ upsertConversation, loadConversations }, write))
      .resolves.toEqual(stored)
    expect(upsertConversation).toHaveBeenNthCalledWith(2, { ...write, expectedRevision: 5 })
  })

  it('does not overwrite a conflict when there is no active lease', async () => {
    const conflict = new StorageError('REVISION_CONFLICT', 'Conversa foi alterada.')
    const upsertConversation = vi.fn().mockRejectedValue(conflict)
    const loadConversations = vi.fn()

    await expect(upsertConversationWithLeaseRecovery(
      { upsertConversation, loadConversations },
      { ...write, lease: undefined }
    )).rejects.toBe(conflict)
    expect(loadConversations).not.toHaveBeenCalled()
  })

  it('serializes only safe storage diagnostics for IPC', () => {
    expect(storageErrorForIpc(new StorageError('DML_FAILED', 'O PostgreSQL rejeitou a gravação.')).message)
      .toBe('[agent-code-storage-error:DML_FAILED:fatal] O PostgreSQL rejeitou a gravação.')
    expect(storageErrorForIpc(new Error('password=secret')).message).not.toContain('secret')
  })
})
