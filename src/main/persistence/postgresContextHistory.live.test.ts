// @vitest-environment node
// PostgreSQL real descartável, opt-in como postgresRepository.test.ts.
// AGENT_CODE_PG_INTEGRATION=1 AGENT_CODE_PG_PORT=55433 npx vitest run --no-file-parallelism src/main/persistence/postgresContextHistory.live.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client, type Pool, type QueryResult } from 'pg'
import { savePostgresContextTurn } from './postgresContextHistory'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import type { ContextBlock } from '../../shared/contextSnapshot'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { contextTextHash } from './contextHistoryCodec'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import type { ContextTurnWrite } from './types'

const integration = process.env.AGENT_CODE_PG_INTEGRATION === '1'
const draft: PostgresConnectionDraft = {
  host: process.env.AGENT_CODE_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_CODE_PG_PORT ?? 55432),
  user: 'postgres',
  password: process.env.AGENT_CODE_PG_PASSWORD ?? 'agent-code-test-password',
  maintenanceDatabase: 'postgres',
  tlsMode: 'disable',
  ca: ''
}

function block(text: string): ContextBlock {
  return { kind: 'user-request', label: 'Pedido', source: 'prompt', hash: contextTextHash(text),
    bytes: Buffer.byteLength(text), at: 1000, text }
}

function turn(turnId: string, text: string, patch: Partial<ContextTurnWrite> = {}): ContextTurnWrite {
  return { convId: 'conv-1', turnId, pc: 'PC-A', startedAt: 1000, model: 'model', models: [], provider: 'claude',
    request: 'pedido', blocks: [block(text)], memoriesSent: [], complete: false, secrets: [], usage: null, ...patch }
}

function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/** Intercepta só a fronteira de query; transações/locks/SQL continuam reais.
 * Permite interleavings determinísticos sem sleeps nem alterar produção. */
function queryHarness(pool: Pool, hook: (
  sql: string, params: unknown[], run: () => Promise<QueryResult>
) => Promise<QueryResult>): Pool {
  return new Proxy(pool, {
    get(target, key) {
      if (key === 'connect') return async () => {
        const client = await target.connect()
        return new Proxy(client, {
          get(target, key) {
            if (key === 'query') return (sql: string, params: unknown[] = []) =>
              hook(sql, params, () => target.query(sql, params))
            const value = Reflect.get(target, key)
            return typeof value === 'function' ? value.bind(target) : value
          }
        })
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

describe.runIf(integration).sequential('PostgresRepository — histórico do contexto', () => {
  let repo: PostgresRepository
  let pool: Pool

  beforeEach(async () => {
    const admin = new Client(postgresClientConfig(draft, draft.maintenanceDatabase))
    await admin.connect()
    try {
      await admin.query('DROP DATABASE IF EXISTS "agent-code"')
    } finally {
      await admin.end()
    }
    const installationId = randomUUID()
    const provisioned = await provisionPostgres(draft, installationId, 'test')
    pool = provisioned.pool
    repo = new PostgresRepository(pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
    await repo.initialize()
    // Deixa a manutenção do boot terminar antes de assertions de contagem.
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    for (const id of ['conv-1', 'conv-2']) {
      await repo.upsertConversation({ id, payload: { id, messages: [] } })
    }
  })

  afterEach(async () => {
    await repo?.close()
  })

  it('roundtrip, dedup, upsert e referências sem texto (inclui Unicode e NUL)', async () => {
    const text = 'Olá\0 — contexto '.repeat(100)
    const write = turn('t1', text, {
      pc: 'PC\0A', request: 'pedido\0completo',
      blocks: [{ ...block(text), hash: '' }],
      memoriesSent: ['user/ação.md'], secrets: [{ name: 'senha', length: 12 }],
      models: [{ model: 'claude-opus-5-5', calls: 2, node: null }, { model: 'gpt-6.1-sol', calls: 1, node: 'task-1' }],
      usage: { detail: 'summary', at: 1001, totalTokens: 10, maxTokens: 100, percentage: 10, categories: [] }
    })
    await repo.saveContextTurn(write)
    await repo.saveContextTurn(turn('t2', text, { startedAt: 2000 }))
    await repo.saveContextTurn({ ...write, complete: true })
    const detail = await repo.readContextTurn('conv-1', 't1')
    expect(detail).toMatchObject({ ...write, complete: true, blockCount: 1, totalBytes: Buffer.byteLength(text),
      blocks: [{ ...write.blocks[0], hash: contextTextHash(text) }] })
    expect((await pool.query('SELECT COUNT(*)::integer AS n FROM context_blob')).rows[0].n).toBe(1)
    expect((await pool.query('SELECT COUNT(*)::integer AS n FROM context_turn')).rows[0].n).toBe(2)
    const refs = (await pool.query('SELECT blocks_json FROM context_turn WHERE turn_id = $1', ['t1'])).rows[0].blocks_json
    expect(Object.keys(refs[0]).sort()).toEqual(['at', 'bytes', 'hash', 'kind', 'label', 'source'])
    expect(await repo.readContextTurn('conv-1', 'missing')).toBeNull()
    const summary = await repo.listContextTurns('conv-1', 1)
    expect(summary.map((entry) => entry.turnId)).toEqual(['t2'])
    expect(summary[0]).not.toHaveProperty('blocks')
  })

  it('apaga os turnos junto da conversa e poda só órfãos', async () => {
    await repo.saveContextTurn(turn('t1', 'compartilhado', { blocks: [block('compartilhado'), block('órfão')] }))
    await repo.saveContextTurn(turn('t2', 'compartilhado', { convId: 'conv-2' }))
    expect(await repo.pruneOrphanContextBlobs()).toBe(0)
    const current = (await repo.loadConversations({ ids: ['conv-1'] }))[0]
    await repo.deleteConversation({ id: current.id, expectedRevision: current.revision })
    expect(await repo.listContextTurns('conv-1', 10)).toEqual([])
    expect(await repo.pruneOrphanContextBlobs()).toBe(1)
    expect((await repo.readContextTurn('conv-2', 't2'))!.blocks[0].text).toBe('compartilhado')
    expect(await repo.deleteContextTurns('conv-2')).toBe(1)
    expect(await repo.deleteContextTurns('conv-2')).toBe(0)
    expect(await repo.pruneOrphanContextBlobs()).toBe(1)
  })

  it('delete concorrente e snapshots atrasados não ressuscitam a conversa', async () => {
    const current = (await repo.loadConversations({ ids: ['conv-1'] }))[0]
    await repo.saveContextTurn(turn('t1', 'início'))
    await Promise.all([
      repo.deleteConversation({ id: current.id, expectedRevision: current.revision }),
      repo.saveContextTurn(turn('t1', 'fim concorrente', { complete: true })),
      repo.saveContextTurn(turn('t2', 'outro concorrente'))
    ])
    await repo.pruneOrphanContextBlobs()
    await repo.saveContextTurn(turn('t1', 'fim atrasado', { complete: true }))
    await repo.saveContextTurn(turn('late-new', 'outro atrasado'))
    expect(await repo.listContextTurns('conv-1', 10)).toEqual([])
    expect((await pool.query('SELECT COUNT(*)::integer AS n FROM context_blob')).rows[0].n).toBe(0)
  })

  it('não grava turno nem blob para conversa inexistente', async () => {
    await repo.saveContextTurn(turn('missing', 'não persistir', { convId: 'missing-parent' }))
    expect(await repo.listContextTurns('missing-parent', 10)).toEqual([])
    expect((await pool.query('SELECT COUNT(*)::integer AS n FROM context_blob')).rows[0].n).toBe(0)
  })

  it('ausência → create → delete enquanto save está bloqueado não ressuscita contexto', async () => {
    const checked = barrier()
    const resume = barrier()
    const intercepted = queryHarness(pool, async (sql, _params, run) => {
      const result = await run()
      if (sql.startsWith('SELECT deleted_at FROM conversations')) {
        expect(result.rows).toEqual([])
        checked.release()
        await resume.promise
      }
      return result
    })
    const saving = savePostgresContextTurn(intercepted, turn('late', 'atrasado', { convId: 'initially-absent' }))
    await checked.promise
    try {
      const parent = await repo.upsertConversation({ id: 'initially-absent', payload: { id: 'initially-absent' } })
      await repo.deleteConversation({ id: parent.id, expectedRevision: parent.revision })
    } finally {
      resume.release()
    }
    await saving
    expect(await repo.listContextTurns('initially-absent', 10)).toEqual([])
    expect((await pool.query('SELECT COUNT(*)::integer AS n FROM context_blob')).rows[0].n).toBe(0)
  })

  it('saves concorrentes [A,B]/[B,A] adquirem blobs em ordem única sem deadlock', async () => {
    const bothStarted = barrier()
    const bothInserted = barrier()
    const firstHashes: string[] = []
    let inserted = 0
    const instrument = () => {
      let first = true
      return queryHarness(pool, async (sql, params, run) => {
        if (!sql.startsWith('INSERT INTO context_blob') || !first) return run()
        first = false
        firstHashes.push(String(params[0]))
        if (firstHashes.length === 2) bothStarted.release()
        await bothStarted.promise
        const result = await run()
        // Ordem inversa: força ambas as primeiras inserções antes da segunda,
        // reproduzindo o ciclo de locks. Ordem canônica: a segunda transação
        // espera o MESMO primeiro hash; não a bloqueamos em uma barreira falsa.
        if (firstHashes[0] !== firstHashes[1]) {
          inserted += 1
          if (inserted === 2) bothInserted.release()
          await bothInserted.promise
        }
        return result
      })
    }
    const a = block('A')
    const b = block('B')
    const outcomes = await Promise.allSettled([
      savePostgresContextTurn(instrument(), turn('ab', '', { blocks: [a, b] })),
      savePostgresContextTurn(instrument(), turn('ba', '', { convId: 'conv-2', blocks: [b, a] }))
    ])
    expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(firstHashes[0]).toBe(firstHashes[1])
    expect((await pool.query('SELECT COUNT(*)::integer AS n FROM context_blob')).rows[0].n).toBe(2)
    expect((await repo.readContextTurn('conv-1', 'ab'))!.blocks.map((b) => b.text)).toEqual(['A', 'B'])
    expect((await repo.readContextTurn('conv-2', 'ba'))!.blocks.map((b) => b.text)).toEqual(['B', 'A'])
  })

  it('rollback da escrita do turno não deixa blobs inseridos', async () => {
    await pool.query(`ALTER TABLE context_turn ADD CONSTRAINT context_test_reject CHECK (turn_id <> 'reject')`)
    await expect(repo.saveContextTurn(turn('reject', 'não gravar'))).rejects.toThrow()
    expect((await pool.query('SELECT COUNT(*)::integer AS n FROM context_blob')).rows[0].n).toBe(0)
    expect(await repo.readContextTurn('conv-1', 'reject')).toBeNull()
  })

  it('listar não descomprime blobs (detalhe expõe corrupção)', async () => {
    await repo.saveContextTurn(turn('t1', 'texto'))
    await pool.query('UPDATE context_blob SET gz = $1', [Buffer.from('invalid gzip')])
    expect((await repo.listContextTurns('conv-1', 10))[0].blockCount).toBe(1)
    await expect(repo.readContextTurn('conv-1', 't1')).rejects.toThrow()
  })
})
