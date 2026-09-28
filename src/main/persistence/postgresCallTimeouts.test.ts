// @vitest-environment node
// O append do espelho e a renovação do lease mandam `query_timeout` próprio em
// TODA consulta (no máximo POSTGRES_CALL_TIMEOUT_MS, nunca o teto geral de
// 130s), e as duas transações levam um `lock_timeout` MENOR que esse teto: numa
// espera por trava o servidor corta primeiro.
import { describe, expect, it, vi } from 'vitest'
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import type { Pool } from 'pg'
import { createPostgresSessionStore } from './postgresSessionStore'
import { PostgresRepository } from './postgresRepository'
import { appendBeginSql, hotPathBeginSql } from './postgresSessionSetup'
import { HOT_PATH_LOCK_TIMEOUT_MS, POSTGRES_CALL_TIMEOUT_MS, POSTGRES_LOCK_TIMEOUT_MS } from './postgresTimeouts'

type Sent = { text: string; values?: unknown[]; query_timeout?: number }

function fakeClient() {
  const sent: Sent[] = []
  const query = vi.fn(async (config: Sent | string) => {
    const call = typeof config === 'string' ? { text: config } : config
    sent.push(call)
    if (call.text.includes('txid_current')) return { rows: [{ txid: '900' }], rowCount: 1 }
    if (call.text.includes('MAX(sequence)')) return { rows: [{ sequence: 0 }], rowCount: 1 }
    if (call.text.includes('INSERT INTO sdk_session_entries')) return { rows: [], rowCount: 1 }
    if (call.text.includes('UPDATE conversation_leases')) {
      return { rowCount: 1, rows: [{ expires_at: new Date('2026-09-26T00:01:00Z') }] }
    }
    return { rows: [], rowCount: 0 }
  })
  const release = vi.fn()
  return { client: { query, release }, sent, release }
}

describe('teto por chamada nos caminhos quentes', () => {
  it('lock_timeout das transações quentes fica abaixo do teto do cliente por consulta', () => {
    expect(HOT_PATH_LOCK_TIMEOUT_MS).toBeLessThan(POSTGRES_CALL_TIMEOUT_MS)
    // O lock_timeout da sessão (15s) empataria com o teto do cliente (15s).
    expect(HOT_PATH_LOCK_TIMEOUT_MS).toBeLessThan(POSTGRES_LOCK_TIMEOUT_MS)
    expect(appendBeginSql()).toMatch(new RegExp(`^BEGIN; SET LOCAL lock_timeout = ${HOT_PATH_LOCK_TIMEOUT_MS}; `))
    expect(hotPathBeginSql()).toBe(`BEGIN; SET LOCAL lock_timeout = ${HOT_PATH_LOCK_TIMEOUT_MS}`)
  })

  it('append do espelho: BEGIN com lock_timeout curto, cada consulta e COMMIT com teto acima dele', async () => {
    const { client, sent, release } = fakeClient()
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    const store = createPostgresSessionStore(pool, 'conv-1')
    const entry = { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'oi' } } as unknown as SessionStoreEntry

    await store.append({ projectKey: 'p', sessionId: 's-1' }, [entry])

    expect(sent[0].text).toBe(appendBeginSql())
    expect(sent[1].text).toContain('txid_current()')
    expect(sent.at(-1)?.text).toBe('COMMIT')
    expect(sent.length).toBeGreaterThan(4)
    for (const call of sent) {
      expect(call.query_timeout).toBeLessThanOrEqual(POSTGRES_CALL_TIMEOUT_MS)
      expect(call.query_timeout).toBeGreaterThan(HOT_PATH_LOCK_TIMEOUT_MS)
    }
    expect(release).toHaveBeenCalledWith(undefined)
  })

  it('append que estoura o teto: a conexão é descartada, não volta ao pool', async () => {
    const { client, release } = fakeClient()
    client.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 })) // BEGIN
    client.query.mockImplementationOnce(async () => {
      throw new Error('Query read timeout')
    })
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    const store = createPostgresSessionStore(pool, 'conv-1')
    const entry = { type: 'user', uuid: 'u-1' } as unknown as SessionStoreEntry

    await expect(store.append({ projectKey: 'p', sessionId: 's-1' }, [entry])).rejects.toThrow('Query read timeout')
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ message: 'Query read timeout' }))
  })

  it('renovação do lease: transação com lock_timeout curto e teto de 15s em cada consulta', async () => {
    const { client, sent, release } = fakeClient()
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    const repository = new PostgresRepository(pool, {}, 'install-1', 'test')
    const lease = { conversationId: 'c', ownerInstallationId: 'install-1', token: 't', fencingEpoch: 3, expiresAt: '' }

    await expect(repository.renewConversationLease(lease)).resolves.toMatchObject({ expiresAt: '2026-09-26T00:01:00.000Z' })
    expect(sent.map((call) => call.text.split('\n')[0].trim())).toEqual([
      hotPathBeginSql(),
      expect.stringContaining('UPDATE conversation_leases'),
      'COMMIT'
    ])
    expect(sent[1].values).toEqual(['c', 'install-1', 't', 3])
    for (const call of sent) expect(call.query_timeout).toBe(POSTGRES_CALL_TIMEOUT_MS)
    expect(release).toHaveBeenCalledWith(undefined)
  })

  it('renovação do lease que não pertence mais a esta instalação: erro depois do COMMIT', async () => {
    const { client, sent, release } = fakeClient()
    client.query.mockImplementation(async (config: Sent | string) => {
      sent.push(typeof config === 'string' ? { text: config } : config)
      return { rows: [], rowCount: 0 }
    })
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    const repository = new PostgresRepository(pool, {}, 'install-1', 'test')
    const lease = { conversationId: 'c', ownerInstallationId: 'install-1', token: 't', fencingEpoch: 3, expiresAt: '' }

    await expect(repository.renewConversationLease(lease)).rejects.toMatchObject({ code: 'LEASE_HELD_BY_OTHER_DEVICE' })
    expect(sent.at(-1)?.text).toBe('COMMIT')
    expect(release).toHaveBeenCalledWith(undefined)
  })
})
