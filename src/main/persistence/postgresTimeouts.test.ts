// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { postgresClientConfig } from './postgresProvisioning'
import { applySessionTimeouts, SESSION_SETUP_TIMEOUT_MS, sessionTimeoutsSql } from './postgresSessionSetup'
import {
  POSTGRES_CALL_TIMEOUT_MS,
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_QUERY_TIMEOUT_MS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
  rollbackOrDiscard,
  timedQuery
} from './postgresTimeouts'

function fakeClient(rollback: () => Promise<unknown>): { client: PoolClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => rollback())
  return { client: { query } as unknown as PoolClient, query }
}

describe('tetos de tempo das sessões PostgreSQL', () => {
  it('o teto do cliente vai na config; os do servidor NÃO vão no startup (o PgBouncer recusaria)', () => {
    const config = postgresClientConfig(
      { host: 'db', port: 5432, user: 'u', password: 'p', maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '' },
      'agent-code'
    ) as Record<string, unknown>
    expect(config.query_timeout).toBe(POSTGRES_QUERY_TIMEOUT_MS)
    // O pg manda estes três como parâmetro de startup se estiverem na config, e
    // o PgBouncer derruba a conexão: "unsupported startup parameter".
    expect(config).not.toHaveProperty('lock_timeout')
    expect(config).not.toHaveProperty('statement_timeout')
    expect(config).not.toHaveProperty('idle_in_transaction_session_timeout')
    expect(config).not.toHaveProperty('options')
    // O servidor cancela primeiro quando ainda é alcançável (a conexão segue
    // utilizável); o teto do cliente só pega o socket meio morto.
    expect(POSTGRES_QUERY_TIMEOUT_MS).toBeGreaterThan(POSTGRES_STATEMENT_TIMEOUT_MS)
    expect(POSTGRES_STATEMENT_TIMEOUT_MS).toBeGreaterThan(POSTGRES_LOCK_TIMEOUT_MS)
  })

  it('os três tetos do servidor saem num SET só, com teto próprio, logo depois de conectar', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    await applySessionTimeouts({ query } as unknown as PoolClient)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith({ text: sessionTimeoutsSql(), query_timeout: SESSION_SETUP_TIMEOUT_MS })
    expect(sessionTimeoutsSql()).toBe(
      `SET lock_timeout = ${POSTGRES_LOCK_TIMEOUT_MS}; SET statement_timeout = ${POSTGRES_STATEMENT_TIMEOUT_MS}; ` +
        `SET idle_in_transaction_session_timeout = ${POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS}`
    )
  })

  it('teto por chamada do append/lease fica entre 10 e 15s, abaixo do geral', () => {
    expect(POSTGRES_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    expect(POSTGRES_CALL_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
    expect(POSTGRES_CALL_TIMEOUT_MS).toBeLessThan(POSTGRES_QUERY_TIMEOUT_MS)
    expect(timedQuery('SELECT $1', [1], 1_234)).toEqual({ text: 'SELECT $1', values: [1], query_timeout: 1_234 })
    expect(timedQuery('BEGIN', undefined, 1_234)).toEqual({ text: 'BEGIN', query_timeout: 1_234 })
  })
})

describe('rollbackOrDiscard', () => {
  it('erro de SQL com ROLLBACK confirmado: a conexão volta ao pool', async () => {
    const { client, query } = fakeClient(async () => ({ rows: [] }))
    const sqlError = Object.assign(new Error('duplicate key'), { code: '23505' })
    await expect(rollbackOrDiscard(client, sqlError)).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('query_timeout: descarta sem mandar ROLLBACK para a fila atrás da consulta presa', async () => {
    const { client, query } = fakeClient(async () => ({ rows: [] }))
    const timeout = new Error('Query read timeout')
    await expect(rollbackOrDiscard(client, timeout)).resolves.toBe(timeout)
    expect(query).not.toHaveBeenCalled()
  })

  it('conexão caída: descarta', async () => {
    const { client, query } = fakeClient(async () => ({ rows: [] }))
    const dropped = new Error('Connection terminated unexpectedly')
    await expect(rollbackOrDiscard(client, dropped)).resolves.toBe(dropped)
    expect(query).not.toHaveBeenCalled()
  })

  it('ROLLBACK que falha: descarta com o erro do ROLLBACK', async () => {
    const rollbackError = new Error('ROLLBACK falhou')
    const { client } = fakeClient(async () => {
      throw rollbackError
    })
    await expect(rollbackOrDiscard(client, new Error('violou constraint'))).resolves.toBe(rollbackError)
  })

  it('lock_timeout do servidor: a sessão está sã, ROLLBACK e reaproveita', async () => {
    const { client, query } = fakeClient(async () => ({ rows: [] }))
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
    await expect(rollbackOrDiscard(client, lockTimeout)).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })
})
