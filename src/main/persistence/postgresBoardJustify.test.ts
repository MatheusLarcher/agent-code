// @vitest-environment node
// Integração real com PostgreSQL (ligada por AGENT_CODE_PG_INTEGRATION=1, como
// postgresRepository.test.ts — `npm run test:pg` sobe o container e roda este
// arquivo junto, em série). Espelha sqliteBoardJustify.test.ts: os dois
// repositórios decidem o MESMO evento (`planPoWriteEvent`).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import type { BoardItem, BoardSourceItem } from './types'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'

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

async function repository(): Promise<PostgresRepository> {
  const installationId = randomUUID()
  const provisioned = await provisionPostgres(draft, installationId, 'test')
  const result = new PostgresRepository(provisioned.pool, postgresClientConfig(draft, POSTGRES_DATABASE), installationId, 'test')
  await result.initialize()
  return result
}

function source(title: string, status: BoardSourceItem['status']): BoardSourceItem {
  return { sourceId: '1', title, status, activeForm: null, seq: 0 }
}

async function oneCard(target: PostgresRepository, status: BoardSourceItem['status'], title = 'uma'): Promise<BoardItem> {
  const [card] = await target.syncBoardItems({
    projectId: 'proj-board',
    projectCwd: 'C:/GitHub/agent-code',
    conversationId: 'conv-board',
    items: [source(title, status)]
  })
  return card
}

describe.runIf(integration).sequential('PostgresRepository — justificativas e autoria', () => {
  const opened: PostgresRepository[] = []

  beforeEach(dropTarget)
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((entry) => entry.close().catch(() => undefined)))
  })

  it('motivo sem mudança de status vira "justified"; o mesmo motivo de novo não', async () => {
    const target = await repository()
    opened.push(target)
    const card = await oneCard(target, 'in_progress')
    const item = await target.applyBoardPo({ id: card.id, poReason: 'fim — falta commitar', eventNote: 'falta commitar' })
    await target.applyBoardPo({ id: card.id, poReason: 'fim — falta commitar' })

    expect(item.poStatus).toBeNull()
    expect(item.poReason).toBe('fim — falta commitar')
    const events = await target.listBoardItemEvents(card.id)
    expect(events.map((e) => e.kind)).toEqual(['created', 'justified'])
    expect(events[1]).toMatchObject({ actor: 'po', fromStatus: 'in_progress', toStatus: 'in_progress', note: 'falta commitar' })
  })

  it('onlyIf falso não grava nem registra evento; verdadeiro grava', async () => {
    const target = await repository()
    opened.push(target)
    const card = await oneCard(target, 'in_progress')
    await target.applyBoardPo({ id: card.id, poStatus: 'completed', poReason: 'entregue' })
    const skipped = await target.applyBoardPo({
      id: card.id,
      poStatus: 'in_progress',
      poReason: 'retomada',
      actor: 'system',
      onlyIf: (current) => current.poStatus === 'pending'
    })
    expect(skipped).toMatchObject({ poStatus: 'completed', poReason: 'entregue' })
    const applied = await target.applyBoardPo({
      id: card.id,
      poReason: 'entregue e testado',
      onlyIf: (current) => current.poStatus === 'completed'
    })
    expect(applied.poReason).toBe('entregue e testado')
    expect((await target.listBoardItemEvents(card.id)).map((e) => e.kind)).toEqual(['created', 'status_changed', 'justified'])
  })

  it('TITULO com motivo leva a nota "título → …: motivo"', async () => {
    const target = await repository()
    opened.push(target)
    const card = await oneCard(target, 'completed', 'add board table 5/7')
    await target.applyBoardPo({ id: card.id, poTitle: 'Criar a tabela do quadro', poReason: 'título técnico demais' })

    const events = await target.listBoardItemEvents(card.id)
    expect(events.at(-1)).toMatchObject({
      kind: 'retitled',
      note: 'título → "Criar a tabela do quadro": título técnico demais'
    })
  })

  it('actor "system" é aceito (migration 14) no status e no dispensar/restaurar', async () => {
    const target = await repository()
    opened.push(target)
    const card = await oneCard(target, 'in_progress')
    await target.applyBoardPo({ id: card.id, poStatus: 'pending', poReason: 'fim de turno', actor: 'system' })
    await target.dismissBoardItem(card.id, true, { actor: 'user', note: 'você dispensou o cartão' })
    await target.dismissBoardItem(card.id, false)

    const events = await target.listBoardItemEvents(card.id)
    expect(events.slice(1)).toEqual([
      expect.objectContaining({ kind: 'status_changed', actor: 'system', note: 'fim de turno' }),
      expect.objectContaining({ kind: 'dismissed', actor: 'user', note: 'você dispensou o cartão' }),
      expect.objectContaining({ kind: 'restored', actor: 'system', note: null })
    ])
  })
})
