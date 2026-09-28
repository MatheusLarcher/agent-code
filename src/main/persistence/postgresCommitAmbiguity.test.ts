// @vitest-environment node
// COMMIT ambíguo no append do espelho: o servidor aplicou (ou não) o COMMIT e a
// resposta se perdeu. A próxima chamada da mesma sessão/subpath pergunta
// txid_status antes de gravar — entradas sem uuid nunca ficam em dobro.
import { describe, expect, it, vi } from 'vitest'
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import type { Pool } from 'pg'
import {
  batchHash,
  databaseIdentity,
  PENDING_COMMIT_TTL_MS,
  PendingCommits,
  PendingCommitUnresolvedError,
  pendingCommitsFor
} from './postgresCommitAmbiguity'
import type { Queryable } from './postgresAppendDeadline'
import { createPostgresSessionStore } from './postgresSessionStore'

type CommitMode = 'ok' | 'applied-lost' | 'applied-reset' | 'dropped-lost'

interface Row {
  sessionId: string
  subpath: string
  uuid: string | null
  entry: { type?: string }
}

const readTimeout = (): Error => new Error('Query read timeout')
const reset = (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
const refused = (): Error => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

let fakeServers = 0

/** Servidor de mentira com transações: o que a tabela guarda só muda no COMMIT. */
class FakeServer {
  rows: Row[] = []
  status = new Map<string, string>()
  commitModes: CommitMode[] = []
  down = false
  /** Força a resposta de txid_status (null = NULL do servidor). */
  statusOverride: string | null | undefined = undefined
  begins = 0
  private nextTxid = 700
  private tx: { id: string; buffer: Row[] } | null = null

  readonly client = {
    query: vi.fn(async (config: string | { text: string; values?: unknown[] }) => this.query(config)),
    release: vi.fn()
  }

  /** Alvo único por servidor: o registro de pendências é por banco. */
  private readonly target = { host: `fake-${++fakeServers}`, port: 5432, database: 'agent-code', user: 'app' }

  readonly pool = this.newPool()

  /** O que a reconexão automática faz: outro objeto Pool, mesmo banco. */
  newPool(): Pool {
    return {
      options: { ...this.target },
      connect: vi.fn(async () => {
        if (this.down) throw refused()
        return this.client
      })
    } as unknown as Pool
  }

  uuidless(sessionId = 's-1'): Row[] {
    return this.rows.filter((row) => row.sessionId === sessionId && row.uuid === null)
  }

  private async query(config: string | { text: string; values?: unknown[] }): Promise<unknown> {
    const text = typeof config === 'string' ? config : config.text
    const values = typeof config === 'string' ? [] : (config.values ?? [])
    if (this.down) throw reset()
    if (text.includes('txid_status')) {
      const status = this.statusOverride !== undefined ? this.statusOverride : (this.status.get(String(values[0])) ?? null)
      return { rows: [{ status }], rowCount: 1 }
    }
    if (text.startsWith('BEGIN')) {
      this.begins += 1
      this.tx = { id: String(this.nextTxid++), buffer: [] }
      this.status.set(this.tx.id, 'in progress')
      return { rows: [], rowCount: 0 }
    }
    if (text.includes('txid_current')) return { rows: [{ txid: this.tx!.id }], rowCount: 1 }
    if (text.includes('MAX(sequence)')) return { rows: [{ sequence: this.rows.length }], rowCount: 1 }
    if (text.includes('INSERT INTO sdk_session_entries')) {
      const [, sessionId, subpath, , uuid, entry] = values as [string, string, string, number, string | null, { type?: string }]
      const all = [...this.rows, ...this.tx!.buffer]
      if (uuid && all.some((row) => row.sessionId === sessionId && row.subpath === subpath && row.uuid === uuid)) {
        return { rows: [], rowCount: 0 }
      }
      this.tx!.buffer.push({ sessionId, subpath, uuid, entry })
      return { rows: [], rowCount: 1 }
    }
    if (text === 'COMMIT') return this.commit()
    if (text === 'ROLLBACK') {
      if (this.tx) this.status.set(this.tx.id, 'aborted')
      this.tx = null
      return { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }

  private commit(): unknown {
    const tx = this.tx!
    this.tx = null
    const mode = this.commitModes.shift() ?? 'ok'
    if (mode === 'dropped-lost') {
      // O COMMIT não chegou; a conexão morreu e o servidor abortou a transação.
      this.status.set(tx.id, 'aborted')
      throw readTimeout()
    }
    this.rows.push(...tx.buffer)
    this.status.set(tx.id, 'committed')
    if (mode === 'applied-lost') throw readTimeout()
    if (mode === 'applied-reset') throw reset()
    return { rows: [], rowCount: 0 }
  }
}

const key = { projectKey: 'p', sessionId: 's-1' }
// Lote com entradas sem uuid IDÊNTICAS entre si — as duas são legítimas.
const batch = [
  { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'oi' } },
  { type: 'custom-title', customTitle: 'Título', sessionId: 's-1' },
  { type: 'tag', tag: 'x', sessionId: 's-1' },
  { type: 'tag', tag: 'x', sessionId: 's-1' }
] as unknown as SessionStoreEntry[]
const otherBatch = [{ type: 'agent-metadata', data: { a: 1 }, sessionId: 's-1' }] as unknown as SessionStoreEntry[]

/** Relógio manual para a retentativa interna não esperar de verdade. */
function manualClock() {
  let t = 0
  return { now: () => t, sleep: async (ms: number) => void (t += ms) }
}

describe('append do espelho com COMMIT ambíguo', () => {
  it('COMMIT aplicado e resposta perdida: a repetição do SDK com o mesmo lote não duplica', async () => {
    const server = new FakeServer()
    server.commitModes = ['applied-lost']
    const store = createPostgresSessionStore(server.pool, 'conv-1')

    await expect(store.append(key, batch)).rejects.toThrow('Query read timeout')
    expect(pendingCommitsFor(server.pool).size).toBe(1)
    await expect(store.append(key, batch)).resolves.toBeUndefined()

    expect(server.uuidless()).toHaveLength(3)
    expect(server.rows).toHaveLength(4)
    expect(server.begins).toBe(1)
    expect(pendingCommitsFor(server.pool).size).toBe(0)
  })

  it('COMMIT aplicado e conexão caída: a própria retentativa interna resolve sem duplicar', async () => {
    const server = new FakeServer()
    server.commitModes = ['applied-reset']
    const store = createPostgresSessionStore(server.pool, 'conv-1', { retry: manualClock() })

    await expect(store.append(key, batch)).resolves.toBeUndefined()
    expect(server.uuidless()).toHaveLength(3)
    expect(server.begins).toBe(1)
  })

  it('COMMIT abortado: a repetição grava o lote, uma vez', async () => {
    const server = new FakeServer()
    server.commitModes = ['dropped-lost']
    const store = createPostgresSessionStore(server.pool, 'conv-1')

    await expect(store.append(key, batch)).rejects.toThrow('Query read timeout')
    expect(server.rows).toHaveLength(0)
    await expect(store.append(key, batch)).resolves.toBeUndefined()
    expect(server.uuidless()).toHaveLength(3)
    expect(server.rows).toHaveLength(4)
    expect(server.begins).toBe(2)
  })

  it('banco fora: rejeita como transitório, mantém a pendência e resolve quando volta', async () => {
    const server = new FakeServer()
    server.commitModes = ['applied-lost']
    const store = createPostgresSessionStore(server.pool, 'conv-1', { retry: manualClock() })
    await expect(store.append(key, batch)).rejects.toThrow('Query read timeout')

    server.down = true
    await expect(store.append(key, batch)).rejects.toThrow(/ECONNREFUSED/)
    expect(pendingCommitsFor(server.pool).size).toBe(1)

    server.down = false
    await expect(store.append(key, batch)).resolves.toBeUndefined()
    expect(server.uuidless()).toHaveLength(3)
    expect(server.begins).toBe(1)
  })

  it('desfecho desconhecido (in progress / NULL): rejeita e mantém, sem gravar', async () => {
    for (const unknown of ['in progress', null]) {
      const server = new FakeServer()
      server.commitModes = ['applied-lost']
      const store = createPostgresSessionStore(server.pool, 'conv-1', { retry: manualClock() })
      await expect(store.append(key, batch)).rejects.toThrow('Query read timeout')

      server.statusOverride = unknown
      const error = await store.append(key, batch).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(PendingCommitUnresolvedError)
      expect(pendingCommitsFor(server.pool).size).toBe(1)
      expect(server.begins).toBe(1)

      server.statusOverride = undefined
      await expect(store.append(key, batch)).resolves.toBeUndefined()
      expect(server.uuidless()).toHaveLength(3)
    }
  })

  it('lote diferente com pendência: resolve antes de gravar — grava se já decidiu, rejeita se não sabe', async () => {
    const server = new FakeServer()
    server.commitModes = ['applied-lost']
    const store = createPostgresSessionStore(server.pool, 'conv-1', { retry: manualClock() })
    await expect(store.append(key, batch)).rejects.toThrow('Query read timeout')

    server.statusOverride = 'in progress'
    await expect(store.append(key, otherBatch)).rejects.toBeInstanceOf(PendingCommitUnresolvedError)
    expect(server.rows).toHaveLength(4)

    server.statusOverride = undefined
    await expect(store.append(key, otherBatch)).resolves.toBeUndefined()
    // O lote ambíguo (gravado) + o novo, na ordem, sem nada em dobro.
    expect(server.uuidless().map((row) => row.entry.type)).toEqual(['custom-title', 'tag', 'tag', 'agent-metadata'])
    expect(pendingCommitsFor(server.pool).size).toBe(0)
  })

  it('pendência de outra sessão ou subpath não bloqueia esta', async () => {
    const server = new FakeServer()
    server.commitModes = ['applied-lost']
    const store = createPostgresSessionStore(server.pool, 'conv-1')
    await expect(store.append(key, batch)).rejects.toThrow('Query read timeout')

    server.statusOverride = 'in progress'
    await expect(store.append({ ...key, subpath: 'subagents/a' }, otherBatch)).resolves.toBeUndefined()
    await expect(store.append({ ...key, sessionId: 's-2' }, otherBatch)).resolves.toBeUndefined()
    expect(pendingCommitsFor(server.pool).size).toBe(1)
  })
})

describe('pendência de COMMIT ambíguo atravessa a reconexão (não depende do objeto Pool)', () => {
  it('pool novo do mesmo banco herda a pendência: a repetição do SDK não duplica', async () => {
    const server = new FakeServer()
    server.commitModes = ['applied-lost']
    await expect(createPostgresSessionStore(server.pool, 'conv-1').append(key, batch)).rejects.toThrow('Query read timeout')

    // setOffline fechou o pool antigo; a reconexão instalou outro, com store novo.
    const reconnected = server.newPool()
    expect(reconnected).not.toBe(server.pool)
    expect(pendingCommitsFor(reconnected).size).toBe(1)
    await expect(createPostgresSessionStore(reconnected, 'conv-1').append(key, batch)).resolves.toBeUndefined()

    expect(server.uuidless()).toHaveLength(3)
    expect(server.rows).toHaveLength(4)
    expect(server.begins).toBe(1)
    expect(pendingCommitsFor(reconnected).size).toBe(0)
  })

  it('controle: se a pendência se perdesse na reconexão, o mesmo cenário duplicaria', async () => {
    const server = new FakeServer()
    server.commitModes = ['applied-lost']
    await expect(createPostgresSessionStore(server.pool, 'conv-1').append(key, batch)).rejects.toThrow('Query read timeout')
    ;(pendingCommitsFor(server.pool) as unknown as { items: Map<string, unknown> }).items.clear()

    await createPostgresSessionStore(server.newPool(), 'conv-1').append(key, batch)
    expect(server.uuidless()).toHaveLength(6)
  })

  it('outro banco não herda a pendência', async () => {
    const server = new FakeServer()
    server.commitModes = ['applied-lost']
    await expect(createPostgresSessionStore(server.pool, 'conv-1').append(key, batch)).rejects.toThrow('Query read timeout')
    const other = new FakeServer()
    expect(pendingCommitsFor(other.pool).size).toBe(0)
    await expect(createPostgresSessionStore(other.pool, 'conv-1').append(key, batch)).resolves.toBeUndefined()
    expect(other.begins).toBe(1)
  })

  it('identidade do banco: alvo da conexão, sem a senha', () => {
    expect(databaseIdentity({ options: { host: 'db.x', port: 6543, database: 'agent-code', user: 'u', password: 'segredo' } })).toBe(
      'db.x:6543/agent-code@u'
    )
    const fromUrl = databaseIdentity({ options: { connectionString: 'postgres://u:segredo@db.x:6543/agent-code' } })
    expect(fromUrl).toBe('db.x:6543/agent-code@u')
    expect(fromUrl).not.toContain('segredo')
    expect(databaseIdentity({ options: { host: 'db.x' } })).toBe(databaseIdentity({ options: { host: 'db.x', port: '5432' } }))
  })
})

describe('PendingCommits', () => {
  const db = (status: string | null) => ({ query: vi.fn(async () => ({ rows: [{ status }], rowCount: 1 })) }) as never as Queryable & {
    query: ReturnType<typeof vi.fn>
  }

  it('hash do lote considera entradas E ordem', () => {
    const a = { type: 'tag', tag: 'a' } as unknown as SessionStoreEntry
    const b = { type: 'tag', tag: 'b' } as unknown as SessionStoreEntry
    expect(batchHash([a, b])).toBe(batchHash([{ ...a }, { ...b }]))
    expect(batchHash([a, b])).not.toBe(batchHash([b, a]))
    expect(batchHash([a])).not.toBe(batchHash([a, a]))
  })

  it('uma pendência por chave (a nova substitui) e expira depois do TTL', async () => {
    let t = 0
    const pending = new PendingCommits(() => t)
    pending.record('k', { txid: '1', batchHash: 'h1' })
    pending.record('k', { txid: '2', batchHash: 'h2' })
    expect(pending.size).toBe(1)
    expect(pending.get('k')?.txid).toBe('2')

    t = PENDING_COMMIT_TTL_MS
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(pending.get('k')).toBeUndefined()
    warn.mockRestore()
    // Sem pendência, nada a perguntar ao servidor.
    const query = db('committed')
    await expect(pending.resolve(query, 'k', 'h2')).resolves.toEqual({ alreadyWritten: false })
    expect(query.query).not.toHaveBeenCalled()
  })

  it('record varre as pendências vencidas de outras chaves', () => {
    let t = 0
    const pending = new PendingCommits(() => t)
    pending.record('a', { txid: '1', batchHash: 'h' })
    t = PENDING_COMMIT_TTL_MS + 1
    pending.record('b', { txid: '2', batchHash: 'h' })
    expect(pending.size).toBe(1)
  })

  it('resolve: committed/aborted decidem e limpam; erro do banco sobe e mantém', async () => {
    const pending = new PendingCommits()
    pending.record('k', { txid: '9', batchHash: 'h', seen: new Map([['x', 1]]) })
    await expect(pending.resolve(db('committed'), 'k', 'h')).resolves.toEqual({
      alreadyWritten: true,
      seen: new Map([['x', 1]])
    })
    expect(pending.size).toBe(0)

    pending.record('k', { txid: '9', batchHash: 'h' })
    await expect(pending.resolve(db('aborted'), 'k', 'h')).resolves.toEqual({ alreadyWritten: false })
    expect(pending.size).toBe(0)

    pending.record('k', { txid: '9', batchHash: 'h' })
    const down = { query: vi.fn(async () => Promise.reject(reset())) } as never as Queryable & { query: ReturnType<typeof vi.fn> }
    await expect(pending.resolve(down, 'k', 'h')).rejects.toThrow('ECONNRESET')
    expect(pending.size).toBe(1)
    expect(down.query).toHaveBeenCalledWith('SELECT txid_status($1::bigint) AS status', ['9'])
  })
})
