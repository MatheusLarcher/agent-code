import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const kv = vi.hoisted(() => ({ read: vi.fn<(key: string) => Promise<string | null>>() }))
const localDir = mkdtempSync(join(tmpdir(), 'accounts-provisional-'))

vi.mock('electron', () => ({ safeStorage: {} }))
vi.mock('../auth', () => ({ claudeAuthStatus: vi.fn(async () => ({ loggedIn: false })) }))
vi.mock('../authExpiry', () => ({ claudeAuthExpiry: { clear: vi.fn() } }))
vi.mock('../login', () => ({ claudeLoginBusyFor: vi.fn(() => false), runClaudeLogin: vi.fn() }))
vi.mock('../persistence/kvFacade', () => ({ readPersistedKv: kv.read, writePersistedKv: vi.fn(async () => undefined) }))
vi.mock('../store', () => ({ getCacheInfo: () => ({ localDir }) }))
vi.mock('./accountSync', () => ({ syncClaudeAccounts: vi.fn(), forgetAccountBackup: vi.fn() }))
vi.mock('./usageQuery', () => ({ fetchAccountWindows: vi.fn() }))

import { claudeAccounts, forgetConversationAccount, resolveSessionAccount, storableSessionAccount } from './index'

describe('conta de sessão com a lista de contas não lida do banco', () => {
  beforeEach(() => {
    forgetConversationAccount('c1')
    kv.read.mockReset()
  })

  it('a sessão roda em default, mas a conta não é devolvida para gravar na conversa', async () => {
    kv.read.mockRejectedValueOnce(new Error('banco fora'))
    const id = await resolveSessionAccount('c1', undefined, 'opus')
    expect(id).toBe('default')
    expect(claudeAccounts.storeReady()).toBe(false)
    expect(storableSessionAccount('c1', id)).toBeUndefined()
  })

  it('banco lido depois: a próxima subida devolve a conta para gravar', async () => {
    kv.read.mockRejectedValueOnce(new Error('banco fora'))
    await resolveSessionAccount('c1', undefined, 'opus')
    expect(storableSessionAccount('c1', 'default')).toBeUndefined()

    kv.read.mockResolvedValueOnce(null)
    const id = await resolveSessionAccount('c1', undefined, 'opus')
    expect(claudeAccounts.storeReady()).toBe(true)
    expect(storableSessionAccount('c1', id)).toBe('default')
  })
})
