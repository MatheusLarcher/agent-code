// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client, type Pool } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { ensurePostgresBoardParent, ensurePostgresBoardUserAction } from './postgresBoardParent'
import { POSTGRES_MIGRATIONS } from './postgresMigrations'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'

/**
 * As colunas aditivas do quadro no PostgreSQL compartilhado (o vínculo da
 * pendência e a ação do usuário): garantidas na abertura, SEM migração numerada
 * — uma numerada faria a versão mais velha do app, no outro PC, recusar o banco
 * (`SCHEMA_TOO_NEW`).
 */

/** Um pool falso: responde à consulta da coluna e registra o resto. */
function fakePool(exists: boolean[], fail?: Error) {
  const queries: string[] = []
  const answer = async (sql: string) => {
    queries.push(sql.trim().split(/\s+/).slice(0, 4).join(' '))
    if (/information_schema\.columns/.test(sql)) return { rowCount: exists.shift() ? 1 : 0, rows: [] }
    if (fail && /ALTER TABLE/.test(sql)) throw fail
    return { rowCount: 0, rows: [] }
  }
  const client = { query: vi.fn(answer), release: vi.fn() }
  const pool = { query: vi.fn(answer), connect: vi.fn(async () => client) } as unknown as Pool
  return { pool, queries, client }
}

describe('ensurePostgresBoardParent', () => {
  it('coluna já existe: só confere, sem ALTER nem lock', async () => {
    const { pool, queries } = fakePool([true])
    expect(await ensurePostgresBoardParent(pool)).toBe(true)
    expect(queries.some((q) => q.startsWith('ALTER'))).toBe(false)
  })

  it('coluna faltando: ALTER aditivo com teto de espera pelo lock, numa transação', async () => {
    const { pool, queries, client } = fakePool([false, true])
    expect(await ensurePostgresBoardParent(pool)).toBe(true)
    expect(queries.filter((q) => !q.startsWith('SELECT'))).toEqual([
      'BEGIN',
      'SET LOCAL lock_timeout =',
      'ALTER TABLE board_items ADD',
      'COMMIT'
    ])
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('ALTER que falha (lock ocupado pelo outro PC): devolve false e o quadro segue sem o vínculo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { pool, queries, client } = fakePool([false], new Error('canceling statement due to lock timeout'))
    expect(await ensurePostgresBoardParent(pool)).toBe(false)
    expect(queries).toContain('ROLLBACK')
    expect(client.release).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('não é migração numerada: nenhuma migração numerada é de parent_id', () => {
    expect(POSTGRES_MIGRATIONS.at(-1)?.version).toBe(18)
    expect(POSTGRES_MIGRATIONS.some((entry) => /parent_id/.test(entry.sql))).toBe(false)
  })
})

describe('ensurePostgresBoardUserAction — o mesmo molde, para po_user_action', () => {
  it('confere a coluna certa e, faltando, cria po_user_action com o teto de lock', async () => {
    const { pool, client } = fakePool([false, true])
    expect(await ensurePostgresBoardUserAction(pool)).toBe(true)
    expect(vi.mocked(pool.query).mock.calls[0][1]).toEqual(['po_user_action'])
    const statements = client.query.mock.calls.map(([sql]) => String(sql))
    expect(statements).toContain('ALTER TABLE board_items ADD COLUMN IF NOT EXISTS po_user_action text')
    expect(statements.some((sql) => /lock_timeout/.test(sql))).toBe(true)
  })

  it('ALTER que falha: devolve false e o quadro segue sem o campo', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { pool, queries } = fakePool([false], new Error('canceling statement due to lock timeout'))
    expect(await ensurePostgresBoardUserAction(pool)).toBe(false)
    expect(queries).toContain('ROLLBACK')
    warn.mockRestore()
  })

  it('não é migração numerada: o app antigo do outro PC não recusa o banco', () => {
    expect(POSTGRES_MIGRATIONS.at(-1)?.version).toBe(18)
    expect(POSTGRES_MIGRATIONS.some((entry) => /po_user_action/.test(entry.sql))).toBe(false)
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

const base = { projectId: 'proj-parent', projectCwd: 'C:/GitHub/agent-code', conversationId: 'conv-parent' }

describe.runIf(integration).sequential('PostgresRepository — vínculo da pendência', () => {
  const opened: PostgresRepository[] = []
  beforeEach(dropTarget)
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((entry) => entry.close().catch(() => undefined)))
  })

  it('a pendência grava e lê o pai; a linha antiga (de antes da coluna) continua legível sem pai', async () => {
    const first = await open()
    opened.push(first.repository)
    const old = await first.repository.createBoardPoItem({ ...base, title: 'Cartão de antes', status: 'completed', reason: 'feito' })
    // Banco "de antes": sem a coluna, como um PC que ainda não atualizou deixaria.
    await first.pool.query('ALTER TABLE board_items DROP COLUMN parent_id')
    await first.repository.close()
    opened.splice(0)

    const second = await open()
    opened.push(second.repository)
    const [before] = await second.repository.listBoardItems({ projectIds: ['proj-parent'] })
    expect(before).toMatchObject({ id: old.id })
    expect(before).not.toHaveProperty('parentId')
    const child = await second.repository.createBoardPoItem({
      ...base,
      title: 'Commitar o cartão de antes',
      status: 'pending',
      reason: 'aguardando autorização do usuário',
      parentId: old.id
    })
    expect(child.parentId).toBe(old.id)
    expect((await second.repository.getBoardItem(child.id))?.parentId).toBe(old.id)
  })

  it('a ação do usuário: grava na NOVA e no PENDENTE, limpa ao trocar o status; banco sem a coluna a ganha ao reabrir', async () => {
    const first = await open()
    opened.push(first.repository)
    const old = await first.repository.createBoardPoItem({ ...base, title: 'Cartão de antes', status: 'pending', reason: 'r' })
    await first.pool.query('ALTER TABLE board_items DROP COLUMN po_user_action')
    await first.repository.close()
    opened.splice(0)

    const second = await open()
    opened.push(second.repository)
    expect(await second.repository.getBoardItem(old.id)).not.toHaveProperty('poUserAction')
    const created = await second.repository.createBoardPoItem({
      ...base,
      title: 'Atualizar a VPS',
      status: 'pending',
      reason: 'aguardando autorização do usuário',
      userAction: 'Autorizar a atualização da VPS'
    })
    expect(created.poUserAction).toBe('Autorizar a atualização da VPS')
    const justified = await second.repository.applyBoardPo({ id: old.id, poReason: 'esperando', userAction: 'Escolher A ou B' })
    expect(justified.poUserAction).toBe('Escolher A ou B')
    const done = await second.repository.applyBoardPo({ id: old.id, poStatus: 'completed', poReason: 'entregue' })
    expect(done).not.toHaveProperty('poUserAction')
  })
})
