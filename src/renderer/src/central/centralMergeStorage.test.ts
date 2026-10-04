import { describe, expect, it, vi } from 'vitest'
import { CENTRAL_ID, type CentralEntry } from '@shared/central'
import type { VersionedConversationDto } from '@shared/ipc'
import type { Conversation } from '../types'
import { createCentralStorage, type CentralStorageDeps } from './centralMergeStorage'

// O laço de rebases com dependências falsas; o fluxo com a storage de verdade está em storage.central.test.ts.

const req = (id: string, ts: number, device: string): CentralEntry =>
  ({ kind: 'request', id, ts, text: id, state: 'delivered', device }) as CentralEntry

const conv = (entries: CentralEntry[]): Conversation => ({
  id: CENTRAL_ID,
  title: 'Central',
  cwd: '',
  model: 'claude-opus-5-5',
  sdkSessionId: null,
  messages: [],
  tokens: { context: 0, output: 0, cost: 0 },
  createdAt: 1,
  updatedAt: 1,
  central: { entries }
})

const record = (revision: number, entries: CentralEntry[]): VersionedConversationDto => ({
  id: CENTRAL_ID,
  payload: conv(entries) as unknown as Record<string, unknown>,
  revision,
  contentHash: `h${revision}`,
  createdAt: '2026-10-02T12:00:00.000Z',
  updatedAt: '2026-10-02T12:00:00.000Z'
})

const storageError = (code: string): Error => new Error(`[agent-code-storage-error:${code}:fatal] falhou`)

describe('createCentralStorage: gravação', () => {
  it('erro que não é conflito numa nova tentativa sobe na hora (sem outro rebase) e a tela ganha o relido', async () => {
    const deps = {
      known: vi.fn(() => record(1, [req('a1', 1, 'pc-a')])),
      reread: vi.fn(async () => record(2, [req('a1', 1, 'pc-a'), req('b1', 2, 'pc-b')])),
      upsert: vi.fn<CentralStorageDeps['upsert']>()
        .mockRejectedValueOnce(storageError('REVISION_CONFLICT'))
        .mockRejectedValueOnce(storageError('STORAGE_OFFLINE')),
      normalize: (r: VersionedConversationDto) => r.payload as unknown as Conversation,
      clean: (c: Conversation) => c,
      installationId: async () => 'pc-a'
    }
    const central = createCentralStorage(deps)
    let screen = conv([req('a1', 1, 'pc-a'), req('a2', 3, 'pc-a')])
    central.register((fn) => (screen = fn(screen)))

    await expect(central.write(screen)).rejects.toThrow(/STORAGE_OFFLINE/)
    expect(deps.upsert).toHaveBeenCalledTimes(2)
    expect(deps.upsert.mock.calls.map(([, expected]) => expected)).toEqual([1, 2])
    expect(deps.reread).toHaveBeenCalledTimes(1)
    expect(screen.central?.entries.map((e) => e.id)).toEqual(['a1', 'b1', 'a2'])
  })
})
