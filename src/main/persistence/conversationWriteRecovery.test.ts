import { describe, expect, it, vi } from 'vitest'
import { StorageError, type ConversationWrite, type VersionedConversation } from './types'
import {
  deleteConversationWithLeaseRecovery,
  sessionLeaseRenewal,
  storageErrorForIpc,
  upsertConversationWithLeaseRecovery
} from './conversationWriteRecovery'
import { isTransientPostgresError } from './postgresRetry'

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

  it('lease vencido na queda e ainda nosso: renova e repete a gravação uma vez', async () => {
    const expired = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
    const upsertConversation = vi.fn().mockRejectedValueOnce(expired).mockResolvedValueOnce(stored)
    const renewLease = vi.fn(async () => ({ token: 'lease', fencingEpoch: 2 }))

    await expect(upsertConversationWithLeaseRecovery(
      { upsertConversation, loadConversations: vi.fn() },
      write,
      renewLease
    )).resolves.toEqual(stored)
    expect(renewLease).toHaveBeenCalledTimes(1)
    expect(upsertConversation).toHaveBeenCalledTimes(2)
    expect(upsertConversation).toHaveBeenNthCalledWith(2, write)
  })

  it('lease tomado por outro dispositivo continua terminal: a renovação falha e nada é gravado', async () => {
    const held = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
    const upsertConversation = vi.fn().mockRejectedValue(held)
    const renewLease = vi.fn(async () => null)

    await expect(upsertConversationWithLeaseRecovery(
      { upsertConversation, loadConversations: vi.fn() },
      write,
      renewLease
    )).rejects.toBe(held)
    expect(upsertConversation).toHaveBeenCalledTimes(1)
  })

  it('renova no máximo uma vez: se o fence ainda recusa depois de renovar, a falha sobe', async () => {
    const held = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
    const upsertConversation = vi.fn().mockRejectedValue(held)
    const renewLease = vi.fn(async () => ({ token: 'lease', fencingEpoch: 2 }))

    await expect(upsertConversationWithLeaseRecovery(
      { upsertConversation, loadConversations: vi.fn() },
      write,
      renewLease
    )).rejects.toBe(held)
    expect(renewLease).toHaveBeenCalledTimes(1)
    expect(upsertConversation).toHaveBeenCalledTimes(2)
  })

  it('a repetição depois da renovação resolve o repositório ativo de novo (reconexão durante a renovação)', async () => {
    const expired = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
    const old = { upsertConversation: vi.fn().mockRejectedValue(expired), loadConversations: vi.fn() }
    const fresh = { upsertConversation: vi.fn().mockResolvedValue(stored), loadConversations: vi.fn() }
    let active = old
    const renewLease = vi.fn(async () => {
      active = fresh
      return { token: 'lease', fencingEpoch: 2 }
    })

    await expect(upsertConversationWithLeaseRecovery(() => active, write, renewLease)).resolves.toEqual(stored)
    expect(old.upsertConversation).toHaveBeenCalledTimes(1)
    expect(fresh.upsertConversation).toHaveBeenCalledWith(write)
  })

  it('renovação com falha transitória: sai como erro de armazenamento repetível, não como "outro writer"', async () => {
    const expired = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
    const upsertConversation = vi.fn().mockRejectedValue(expired)
    const renewLease = vi.fn(async () => {
      throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })
    })

    const error = await upsertConversationWithLeaseRecovery(
      { upsertConversation, loadConversations: vi.fn() },
      write,
      renewLease
    ).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(StorageError)
    expect(error).toMatchObject({ code: 'STORAGE_OFFLINE', retryable: true })
    expect(isTransientPostgresError(error)).toBe(true)
    expect(storageErrorForIpc(error).message).toMatch(/^\[agent-code-storage-error:STORAGE_OFFLINE:retryable\]/)
    expect(upsertConversation).toHaveBeenCalledTimes(1)
  })

  it('sessionLeaseRenewal: lease ainda nosso devolve o fence renovado', async () => {
    const keeper = { lease: { token: 'lease', fencingEpoch: 3 }, renewNow: vi.fn(async () => true) }
    await expect(sessionLeaseRenewal(keeper, () => true)()).resolves.toEqual({ token: 'lease', fencingEpoch: 3 })
  })

  it('sessionLeaseRenewal: falha com o keeper ainda da conversa é transitória (rejeita)', async () => {
    const keeper = { lease: { token: 'lease', fencingEpoch: 3 }, renewNow: vi.fn(async () => false) }
    await expect(sessionLeaseRenewal(keeper, () => true)()).rejects.toMatchObject({ code: 'STORAGE_OFFLINE', retryable: true })
  })

  it('LEASE_HELD real (onLost tirou o keeper): o save continua terminal com o erro original', async () => {
    const held = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
    const upsertConversation = vi.fn().mockRejectedValue(held)
    let current = true
    // renewNow viu LEASE_HELD e o onLost do index.ts apagou o keeper do mapa.
    const keeper = { lease: { token: 'lease', fencingEpoch: 3 }, renewNow: vi.fn(async () => ((current = false), false)) }

    await expect(upsertConversationWithLeaseRecovery(
      { upsertConversation, loadConversations: vi.fn() },
      write,
      sessionLeaseRenewal(keeper, () => current)
    )).rejects.toBe(held)
    expect(upsertConversation).toHaveBeenCalledTimes(1)
  })

  it('exclusão com fence: renova e repete uma vez, pelo repositório ativo', async () => {
    const expired = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
    const old = { deleteConversation: vi.fn().mockRejectedValue(expired) }
    const fresh = { deleteConversation: vi.fn().mockResolvedValue(stored) }
    let active: typeof old | typeof fresh = old
    const input = { id: 'conversation', expectedRevision: 6, lease: { token: 'lease', fencingEpoch: 2 } }
    const renewLease = vi.fn(async () => {
      active = fresh
      return { token: 'lease', fencingEpoch: 3 }
    })

    await expect(deleteConversationWithLeaseRecovery(() => active, input, renewLease)).resolves.toEqual(stored)
    expect(fresh.deleteConversation).toHaveBeenCalledWith({ ...input, lease: { token: 'lease', fencingEpoch: 3 } })
  })

  it('exclusão: outro dono continua terminal; sem lease não renova', async () => {
    const held = new StorageError('LEASE_HELD_BY_OTHER_DEVICE', 'Lease ou fencing token inválido.')
    const deleteConversation = vi.fn().mockRejectedValue(held)
    const renewLease = vi.fn(async () => null)
    const input = { id: 'conversation', expectedRevision: 6, lease: { token: 'lease', fencingEpoch: 2 } }

    await expect(deleteConversationWithLeaseRecovery({ deleteConversation }, input, renewLease)).rejects.toBe(held)
    await expect(deleteConversationWithLeaseRecovery({ deleteConversation }, { ...input, lease: undefined }, renewLease))
      .rejects.toBe(held)
    expect(renewLease).toHaveBeenCalledTimes(1)
    expect(deleteConversation).toHaveBeenCalledTimes(2)
  })

  it('serializes only safe storage diagnostics for IPC', () => {
    expect(storageErrorForIpc(new StorageError('DML_FAILED', 'O PostgreSQL rejeitou a gravação.')).message)
      .toBe('[agent-code-storage-error:DML_FAILED:fatal] O PostgreSQL rejeitou a gravação.')
    expect(storageErrorForIpc(new Error('password=secret')).message).not.toContain('secret')
  })
})
