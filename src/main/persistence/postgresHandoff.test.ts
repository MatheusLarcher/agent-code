// @vitest-environment node
// Integração real com PostgreSQL (ligada por AGENT_CODE_PG_INTEGRATION=1 —
// `npm run test:pg` sobe o container e roda este arquivo junto, em série).
// Espelha sqliteHandoff.test.ts e cobre o que só o servidor prova: escape de
// texto livre, `timestamptz`/`bigint` voltando na forma do SQLite, incremento
// concorrente sem perda, cascata, ausência de gatilho e a troca de backend.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, type Pool } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { handoffContentHash } from '../handoffTracking/handoffModel'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import { importRepositoryToPostgres, writeRepositoryToSqlite } from './postgresTransfer'
import { SqliteRepository } from './sqliteRepository'
import type { HandoffEnvioCreate } from './types'

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

/** O texto que o escape do PostgreSQL precisa atravessar: NUL e o marcador reservado. */
const TRICKY = 'nul\u0000no meio e \u{E000}agent-code-pg-escape:0 literal'

function envio(ordem: number, patch: Partial<HandoffEnvioCreate> = {}): HandoffEnvioCreate {
  return {
    planSlug: 'plano-1',
    planTitulo: `Plano ${TRICKY}`,
    projectId: 'proj-1',
    projectCwd: 'C:/GitHub/agent-code',
    conversationId: 'conv-1',
    conversationTitle: `Conversa ${TRICKY}`,
    arquivo: `0${ordem}-prompt.md`,
    ordem,
    loteId: 'lote-1',
    conteudo: `Prompt ${ordem} ${TRICKY}\r\n`,
    entregas: [
      { etapaId: `etapa-${ordem}a`, etapaTitulo: `Primeira ${TRICKY}`, estimativaPlano: 30 },
      { etapaId: `etapa-${ordem}b`, etapaTitulo: 'Segunda', estimativaPlano: null },
      { etapaId: `etapa-${ordem}c`, etapaTitulo: 'Terceira', estimativaPlano: 15 }
    ],
    ...patch
  }
}

describe.runIf(integration).sequential('PostgresRepository — envios de handoff', () => {
  const opened: Array<{ close(): Promise<void> }> = []
  const dirs: string[] = []

  async function repository(): Promise<{ repo: PostgresRepository; pool: Pool; installationId: string }> {
    const installationId = randomUUID()
    const provisioned = await provisionPostgres(draft, installationId, 'test')
    const repo = new PostgresRepository(provisioned.pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
    await repo.initialize()
    opened.push(repo)
    return { repo, pool: provisioned.pool, installationId }
  }

  async function sqlite(): Promise<{ repo: SqliteRepository; dir: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-handoff-pg-'))
    dirs.push(dir)
    const repo = new SqliteRepository(dir, join(dir, 'agent-code.db'), 'device-sqlite')
    await repo.initialize()
    opened.push(repo)
    return { repo, dir }
  }

  beforeEach(dropTarget)
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((entry) => entry.close().catch(() => undefined)))
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('cria o lote numa transação: na_fila, hash normalizado, totais, texto livre escapado e datas em ISO', async () => {
    const { repo, pool } = await repository()
    const created = await repo.createHandoffEnvios([envio(1), envio(2, { entregas: [] })])
    const [first, second] = created

    expect(created.map((item) => item.ordem)).toEqual([1, 2])
    expect(first).toMatchObject({
      status: 'na_fila',
      planTitulo: `Plano ${TRICKY}`,
      conversationTitle: `Conversa ${TRICKY}`,
      conteudo: `Prompt 1 ${TRICKY}\r\n`,
      conteudoHash: handoffContentHash(`Prompt 1 ${TRICKY}`),
      estimativaTotal: 45,
      prazoTotal: 45,
      atrasado: false,
      tempoAtivoMs: 0,
      retrabalhoMs: 0,
      enviadoEm: null
    })
    expect(first.criadoEm).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(first.criadoEm).toBe(second.criadoEm)
    expect(first.entregas.map((entrega) => [entrega.etapaId, entrega.ordem, entrega.estimativaPlano, entrega.status])).toEqual([
      ['etapa-1a', 1, 30, 'pendente'],
      ['etapa-1b', 2, null, 'pendente'],
      ['etapa-1c', 3, 15, 'pendente']
    ])
    expect(first.entregas[0].etapaTitulo).toBe(`Primeira ${TRICKY}`)
    expect(second).toMatchObject({ entregas: [], estimativaTotal: null, prazoTotal: null })
    // O que está gravado não tem NUL: passou pelo escape.
    const raw = await pool.query<{ conteudo: string }>('SELECT conteudo FROM handoff_envios WHERE id = $1', [first.id])
    expect(raw.rows[0].conteudo).not.toContain('\u0000')

    // Um inválido no lote: nada entra.
    await expect(repo.createHandoffEnvios([envio(3), envio(4, { ordem: 0 })])).rejects.toThrow(/ordem/)
    expect(await repo.listHandoffEnvios({})).toHaveLength(2)
  })

  it('lista com filtros, limite e ordem criado_em DESC, ordem ASC', async () => {
    const { repo } = await repository()
    const antigo = await repo.createHandoffEnvios([envio(1), envio(2)])
    const novo = await repo.createHandoffEnvios([
      envio(1, { loteId: 'lote-2', conversationId: 'conv-2', projectId: 'proj-2' }),
      envio(2, { loteId: 'lote-2', conversationId: 'conv-2', projectId: 'proj-2' })
    ])
    await repo.updateHandoffEnvio(novo[1].id, { status: 'enviado' })

    const all = await repo.listHandoffEnvios({})
    expect(all.map((item) => item.id)).toEqual([novo[0].id, novo[1].id, antigo[0].id, antigo[1].id])
    expect((await repo.listHandoffEnvios({ conversationId: 'conv-1' })).map((item) => item.id)).toEqual(antigo.map((item) => item.id))
    expect((await repo.listHandoffEnvios({ projectIds: ['proj-2'] })).map((item) => item.id)).toEqual(novo.map((item) => item.id))
    expect((await repo.listHandoffEnvios({ statuses: ['enviado', 'falhou'] })).map((item) => item.id)).toEqual([novo[1].id])
    expect((await repo.listHandoffEnvios({ ids: [antigo[0].id] })).map((item) => item.id)).toEqual([antigo[0].id])
    expect(await repo.listHandoffEnvios({ limit: 3 })).toHaveLength(3)
    expect(await repo.listHandoffEnvios({ projectIds: [] })).toEqual([])
  })

  it('atualiza envio e entrega (null limpa, devolve o pai) e lança quando não existe', async () => {
    const { repo } = await repository()
    const [created] = await repo.createHandoffEnvios([envio(1)])
    const updated = await repo.updateHandoffEnvio(created.id, {
      status: 'incompleta',
      motivo: `faltou ${TRICKY}`,
      enviadoEm: '2026-10-05T07:01:00-03:00',
      iniciadoEm: '2026-10-05T10:02:00.000Z',
      atrasado: true
    })
    expect(updated).toMatchObject({
      status: 'incompleta',
      motivo: `faltou ${TRICKY}`,
      enviadoEm: '2026-10-05T10:01:00.000Z',
      iniciadoEm: '2026-10-05T10:02:00.000Z',
      atrasado: true
    })
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt))
    expect(await repo.updateHandoffEnvio(created.id, { motivo: null, enviadoEm: null })).toMatchObject({ motivo: null, enviadoEm: null })

    const parent = await repo.updateHandoffEntrega(created.entregas[2].id, {
      status: 'concluida',
      auditada: false,
      boardItemId: 'bi-9',
      concluidaEm: '2026-10-05T10:30:00.000Z',
      tempoCorridoMs: 5_400_000_000,
      estimativaAgente: 40,
      estimativaAgenteMotivo: `revisado ${TRICKY}`,
      aviso100Em: '2026-10-05T10:20:00.000Z'
    })
    expect(parent.id).toBe(created.id)
    expect(parent.entregas[2]).toMatchObject({
      status: 'concluida',
      auditada: false,
      boardItemId: 'bi-9',
      concluidaEm: '2026-10-05T10:30:00.000Z',
      tempoCorridoMs: 5_400_000_000,
      estimativaAgente: 40,
      estimativaAgenteMotivo: `revisado ${TRICKY}`,
      aviso100Em: '2026-10-05T10:20:00.000Z',
      estimativaPlano: 15
    })
    expect((await repo.updateHandoffEntrega(created.entregas[2].id, { auditada: null })).entregas[2].auditada).toBeNull()
    await expect(repo.updateHandoffEnvio('he-nada', { status: 'enviado' })).rejects.toThrow(/inexistente/)
    await expect(repo.updateHandoffEntrega('hn-nada', { status: 'pendente' })).rejects.toThrow(/inexistente/)
  })

  it('addHandoffTime soma atomicamente, inclusive em paralelo, e desfaz o lote com entrega de outro envio', async () => {
    const { repo } = await repository()
    const [a, b] = await repo.createHandoffEnvios([envio(1), envio(2)])
    // 20 incrementos simultâneos (conexões diferentes do pool): ler-e-regravar
    // perderia fatias; `col = col + $n` não perde nenhuma.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        repo.addHandoffTime({ envioId: a.id, ativoMs: 1_000, retrabalhoMs: 10, entregas: [{ id: a.entregas[1].id, ativoMs: 1_000 }] })
      )
    )
    let [current] = await repo.listHandoffEnvios({ ids: [a.id] })
    expect(current).toMatchObject({ tempoAtivoMs: 20_000, retrabalhoMs: 200 })
    expect(current.entregas[1].tempoAtivoMs).toBe(20_000)

    await expect(
      repo.addHandoffTime({ envioId: a.id, ativoMs: 7, entregas: [{ id: b.entregas[0].id, ativoMs: 7 }] })
    ).rejects.toThrow(/não pertence/)
    ;[current] = await repo.listHandoffEnvios({ ids: [a.id] })
    expect(current.tempoAtivoMs).toBe(20_000)
    await expect(repo.addHandoffTime({ envioId: 'he-nada', ativoMs: 1 })).rejects.toThrow(/inexistente/)
  })

  it('cascata ao apagar o envio; sem gatilho de change feed nas tabelas novas', async () => {
    const { repo, pool } = await repository()
    const [a, b] = await repo.createHandoffEnvios([envio(1), envio(2)])
    await repo.updateHandoffEntrega(a.entregas[0].id, { status: 'em_andamento' })
    await pool.query('DELETE FROM handoff_envios WHERE id = $1', [a.id])
    const left = await pool.query<{ envio_id: string }>('SELECT DISTINCT envio_id FROM handoff_entregas')
    expect(left.rows.map((row) => row.envio_id)).toEqual([b.id])

    const triggers = await pool.query(
      `SELECT tgname FROM pg_trigger
       WHERE NOT tgisinternal AND tgrelid IN ('handoff_envios'::regclass, 'handoff_entregas'::regclass)`
    )
    expect(triggers.rows).toEqual([])
    const feed = await pool.query("SELECT 1 FROM change_log WHERE entity_id LIKE 'he-%' OR entity_id LIKE 'hn-%'")
    expect(feed.rowCount).toBe(0)
  })

  it('trocar de backend preserva envios e entregas nos dois sentidos', async () => {
    // SQLite → PostgreSQL
    const source = await sqlite()
    const [first] = await source.repo.createHandoffEnvios([envio(1), envio(2)])
    await source.repo.updateHandoffEnvio(first.id, { status: 'concluida', concluidoEm: '2026-10-05T12:00:00.000Z', motivo: TRICKY })
    await source.repo.updateHandoffEntrega(first.entregas[0].id, { status: 'concluida', auditada: true, corrigidoPor: 'usuario' })
    await source.repo.addHandoffTime({ envioId: first.id, ativoMs: 61_000, entregas: [{ id: first.entregas[0].id, retrabalhoMs: 5_000 }] })
    const expected = await source.repo.listHandoffEnvios({})

    const { repo, pool, installationId } = await repository()
    await importRepositoryToPostgres(pool, source.repo, installationId, randomUUID())
    expect(await repo.listHandoffEnvios({})).toEqual(expected)

    // PostgreSQL → SQLite (com uma escrita feita no PostgreSQL depois da importação)
    await repo.createHandoffEnvios([envio(3, { loteId: 'lote-pg' })])
    const fromPostgres = await repo.listHandoffEnvios({})
    expect(fromPostgres).toHaveLength(3)
    const targetDir = await mkdtemp(join(tmpdir(), 'agent-code-handoff-export-'))
    dirs.push(targetDir)
    const target = join(targetDir, 'agent-code.db')
    const exported = await writeRepositoryToSqlite(repo, target)
    expect(exported.sourceHash).toBe(exported.targetHash)
    const back = new SqliteRepository(targetDir, target, 'device-back')
    await back.initialize()
    opened.push(back)
    expect(await back.listHandoffEnvios({})).toEqual(fromPostgres)
  })
})
