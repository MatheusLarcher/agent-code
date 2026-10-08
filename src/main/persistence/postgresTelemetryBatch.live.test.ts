// @vitest-environment node
// PostgreSQL real descartável, opt-in como os outros testes live:
// AGENT_CODE_PG_INTEGRATION=1 AGENT_CODE_PG_PORT=55433 npx vitest run --no-file-parallelism src/main/persistence/postgresTelemetryBatch.live.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Client, type Pool } from 'pg'
import type { PostgresConnectionDraft } from '../../shared/ipc'
import { POSTGRES_DATABASE } from './bootstrapStore'
import { interactiveRead } from './priorityPool'
import { postgresClientConfig, provisionPostgres } from './postgresProvisioning'
import { PostgresRepository } from './postgresRepository'
import type { TelemetryBatch } from './telemetryBatch'

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

const call = (id: string, seq: number, inputTokens: number, subagentType: string | null = null) => ({
  id, convId: 'conv-1', turnId: 't1', nodeId: subagentType ? `n-${id}` : 't1', parentNodeId: null, subagentType,
  taskDescription: subagentType ? 'tarefa\0com NUL' : null, seq, model: 'claude-opus-5-5', inputTokens, outputTokens: 2,
  cacheReadTokens: 1, cacheWriteTokens: 0, costUsd: null, inputPreview: 'pré\0via', outputPreview: null,
  createdAt: `2026-10-08T12:00:0${seq}.000Z`
})

const total = (subagentType: string, sumInput: number, callCount: number, sumCost: number | null = null) => ({
  convId: 'conv-1', day: '2026-10-08', model: 'claude-opus-5-5', subagentType, sumInput, sumOutput: 2 * callCount,
  sumCacheRead: callCount, sumCacheWrite: 0, sumCost, callCount
})

describe.runIf(integration).sequential('PostgresRepository — telemetria em lote', () => {
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
  })

  afterEach(async () => {
    await repo?.close()
  })

  it('um lote: chamadas em INSERT de várias linhas, correções, totais somados por chave e tempos; reenvio não duplica', async () => {
    const batch: TelemetryBatch = {
      calls: [call('a', 1, 10), call('b', 2, 20), call('c', 3, 5, 'executor')],
      updates: [],
      totals: [total('', 30, 2), total('executor', 5, 1, 0.25)],
      turnTimes: [{ id: randomUUID(), convId: 'conv-1', turnId: 't1', durationMs: 1500.4, createdAt: '2026-10-08T12:00:05.000Z' }]
    }
    await repo.writeTelemetryBatch(batch)
    await repo.writeTelemetryBatch({
      calls: [call('a', 1, 10)],
      updates: [{ id: 'b', inputTokens: 26, outputTokens: 2, cacheReadTokens: 9, cacheWriteTokens: 0, costUsd: 0.5 }],
      totals: [total('', 6, 0), total('executor', 0, 0, 0.25)],
      turnTimes: []
    })

    // Leitura pela faixa interativa (pool reservado): mesmo banco, mesmas linhas.
    const calls = await interactiveRead(() => repo.listLlmCalls('conv-1'))
    expect(calls.map((c) => [c.id, c.inputTokens, c.cacheReadTokens, c.costUsd])).toEqual([
      ['a', 10, 1, null], ['b', 26, 9, 0.5], ['c', 5, 1, null]
    ])
    expect(calls[2]).toMatchObject({ subagentType: 'executor', taskDescription: 'tarefa\0com NUL', inputPreview: 'pré\0via' })
    expect(await repo.listLlmUsageTotals('conv-1')).toEqual([
      expect.objectContaining({ subagentType: null, sumInput: 36, sumOutput: 4, callCount: 2, sumCost: null }),
      expect.objectContaining({ subagentType: 'executor', sumInput: 5, callCount: 1, sumCost: 0.5 })
    ])
    expect(await repo.turnTimeTotals('conv-1')).toEqual({ totalMs: 1500, turns: 1, lastMs: 1500 })
  })
})
