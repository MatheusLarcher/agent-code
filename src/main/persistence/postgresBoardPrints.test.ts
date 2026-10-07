// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client, type Pool } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { ensurePostgresBoardPrints } from './postgresBoardPrints'
import { POSTGRES_MIGRATIONS } from './postgresMigrations'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import { BOARD_PRINT_RETENTION_MS } from './boardPrintPruner'
import type { BoardItemPrintWrite } from './boardPrintTypes'

/**
 * Os prints dos cartões no PostgreSQL compartilhado: tabela garantida na
 * abertura, SEM migração numerada (uma 18 faria a versão mais velha do app, no
 * outro PC, recusar o banco), e o mesmo comportamento do SQLite.
 */

function fakePool(exists: boolean[], fail?: Error) {
  const queries: string[] = []
  const answer = async (sql: string) => {
    queries.push(sql.trim().split(/\s+/).slice(0, 5).join(' '))
    if (/information_schema\.tables/.test(sql)) return { rowCount: exists.shift() ? 1 : 0, rows: [] }
    if (fail && /CREATE TABLE/.test(sql)) throw fail
    return { rowCount: 0, rows: [] }
  }
  const client = { query: vi.fn(answer), release: vi.fn() }
  const pool = { query: vi.fn(answer), connect: vi.fn(async () => client) } as unknown as Pool
  return { pool, queries, client }
}

describe('ensurePostgresBoardPrints', () => {
  it('tabela já existe: só confere', async () => {
    const { pool, queries } = fakePool([true])
    expect(await ensurePostgresBoardPrints(pool)).toBe(true)
    expect(queries.some((q) => q.includes('CREATE TABLE'))).toBe(false)
  })

  it('tabela faltando: CREATE aditivo com teto de espera pelo lock, numa transação', async () => {
    const { pool, queries, client } = fakePool([false, true])
    expect(await ensurePostgresBoardPrints(pool)).toBe(true)
    expect(queries).toEqual(expect.arrayContaining(['BEGIN', 'SET LOCAL lock_timeout = 5000', 'COMMIT']))
    expect(queries.some((q) => q.startsWith('CREATE TABLE IF NOT EXISTS'))).toBe(true)
    expect(client.release).toHaveBeenCalled()
  })

  it('falhou (lock, permissão): devolve false, desfaz e não lança', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { pool, queries } = fakePool([false], new Error('lock timeout'))
    expect(await ensurePostgresBoardPrints(pool)).toBe(false)
    expect(queries).toContain('ROLLBACK')
    warn.mockRestore()
  })

  it('não é migração numerada: a versão do schema continua a 17', () => {
    expect(POSTGRES_MIGRATIONS.at(-1)?.version).toBe(17)
    expect(POSTGRES_MIGRATIONS.some((entry) => /board_item_prints/.test(entry.sql))).toBe(false)
  })
})

// Integração real (AGENT_CODE_PG_INTEGRATION=1, `npm run test:pg`).
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

async function dropTarget(): Promise<void> {
  const client = new Client(postgresClientConfig(draft, draft.maintenanceDatabase))
  await client.connect()
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [POSTGRES_DATABASE])
    await client.query('DROP DATABASE IF EXISTS "agent-code"')
  } finally {
    await client.end()
  }
}

async function open(): Promise<{ repository: PostgresRepository; pool: Pool }> {
  const installationId = randomUUID()
  const provisioned = await provisionPostgres(draft, installationId, 'test')
  const repository = new PostgresRepository(provisioned.pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
  await repository.initialize()
  return { repository, pool: provisioned.pool }
}

const base = { projectId: 'proj-prints', projectCwd: 'C:/GitHub/loja', conversationId: 'conv-prints' }
const DAY = 24 * 60 * 60_000
const iso = (ms: number): string => new Date(ms).toISOString()

function print(id: string, boardItemId: string, createdAt: string): BoardItemPrintWrite {
  return {
    id, boardItemId, projectId: 'proj-prints', conversationId: 'conv-prints', mime: 'image/jpeg', width: 800, height: 600,
    legenda: `print ${id}`, createdAt, data: new Uint8Array([1, 2, 3, id.length]), thumb: new Uint8Array([9])
  }
}

describe.runIf(integration).sequential('PostgresRepository — prints dos cartões', () => {
  const opened: PostgresRepository[] = []
  beforeEach(dropTarget)
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((entry) => entry.close().catch(() => undefined)))
  })

  it('4 por cartão, leitura com e sem a imagem grande, e a faxina dos 30 dias', async () => {
    const { repository, pool } = await open()
    opened.push(repository)
    const now = Date.now()
    const card = await repository.createBoardPoItem({ ...base, title: 'Tela de login', status: 'in_progress', reason: 'r' })
    for (let i = 1; i <= 5; i++) await repository.addBoardItemPrint(print(`p${i}`, card.id, iso(now + i * 60_000)), 4)
    expect((await repository.listBoardItemPrints({ boardItemId: card.id })).map((p) => p.id)).toEqual(['p5', 'p4', 'p3', 'p2'])
    expect(Array.from((await repository.getBoardItemPrint('p5'))!.data)).toEqual([1, 2, 3, 2])

    const done = await repository.createBoardPoItem({ ...base, title: 'Concluída há 40 dias', status: 'completed', reason: 'r' })
    await pool.query('UPDATE board_items SET updated_at = $1 WHERE id = $2', [iso(now - 40 * DAY), done.id])
    await repository.addBoardItemPrint(print('velho', done.id, iso(now - 40 * DAY)), 4)
    await repository.addBoardItemPrint(print('orfao', 'sumiu', iso(now - 40 * DAY)), 4)
    expect(await repository.pruneBoardItemPrints(iso(now - BOARD_PRINT_RETENTION_MS))).toBe(2)
    expect((await repository.listBoardItemPrints({ projectId: 'proj-prints' })).map((p) => p.id).sort()).toEqual(['p2', 'p3', 'p4', 'p5'])
  })
})
