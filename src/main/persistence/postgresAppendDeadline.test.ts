// @vitest-environment node
// Prazo único do append do espelho, com relógio falso: pool REAL do pg-pool 3.14
// (timers de conexão, fila e onConnect com o SET de verdade) e um Client de
// mentira que demora o que o cenário mandar e respeita `query_timeout` como o
// `pg`. Em nenhum cenário o append passa do prazo (45s), longe dos 60s do SDK.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { Pool } from 'pg'
import { APPEND_ATTEMPT_MIN_MS, APPEND_CONNECT_BUDGET_MS, AppendDeadline } from './postgresAppendDeadline'
import { MIRROR_APPEND_RETRY_BUDGET_MS } from './postgresRetry'
import { applySessionTimeouts, SESSION_SETUP_TIMEOUT_MS } from './postgresSessionSetup'
import { createPostgresSessionStore } from './postgresSessionStore'
import { POSTGRES_CALL_TIMEOUT_MS, POSTGRES_CONNECT_TIMEOUT_MS } from './postgresTimeouts'

type Delay = number | 'hang'

interface Scenario {
  /** Handshake: ms até conectar, ou 'hang' (o timer de 8s do pg-pool derruba). */
  connectMs: Delay
  /** Handshake preso de um jeito que os timers do pg-pool NÃO resolvem. */
  connectInvisible?: boolean
  /** SET do onConnect. */
  setMs: Delay
  /** Cada consulta do append. */
  queryMs: Delay
  /** A consulta termina com queda de rede (transitório) em vez de resposta. */
  queryReset?: boolean
}

let scenario: Scenario
const sentTimeouts: { text: string; timeout: number | undefined }[] = []

function resultFor(text: string): { rows: unknown[]; rowCount: number } {
  if (text.includes('txid_current')) return { rows: [{ txid: '1' }], rowCount: 1 }
  if (text.includes('MAX(sequence)')) return { rows: [{ sequence: 0 }], rowCount: 1 }
  if (text.includes('INSERT INTO sdk_session_entries')) return { rows: [], rowCount: 1 }
  return { rows: [], rowCount: 0 }
}

class FakeClient extends EventEmitter {
  _queryable = true
  _ending = false
  connection: { stream: { destroy(): void } } | undefined
  private onConnected: ((error?: Error) => void) | null = null

  constructor() {
    super()
    if (!scenario.connectInvisible) {
      this.connection = {
        stream: { destroy: () => this.onConnected?.(new Error('Connection terminated unexpectedly')) }
      }
    }
  }

  isConnected(): boolean {
    return false
  }

  connect(callback: (error?: Error) => void): void {
    let called = false
    this.onConnected = (error) => {
      if (called) return
      called = true
      callback(error)
    }
    if (scenario.connectMs !== 'hang' && !scenario.connectInvisible) {
      setTimeout(() => this.onConnected?.(), scenario.connectMs)
    }
  }

  query(config: string | { text: string; query_timeout?: number }): Promise<unknown> {
    const text = typeof config === 'string' ? config : config.text
    const timeout = typeof config === 'string' ? undefined : config.query_timeout
    sentTimeouts.push({ text, timeout })
    const isSet = text.startsWith('SET lock_timeout')
    const ms = isSet ? scenario.setMs : scenario.queryMs
    return new Promise((resolve, reject) => {
      let done = false
      if (timeout !== undefined) {
        setTimeout(() => {
          if (done) return
          done = true
          reject(new Error('Query read timeout'))
        }, timeout)
      }
      if (ms === 'hang') return
      setTimeout(() => {
        if (done) return
        done = true
        if (!isSet && scenario.queryReset) reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
        else resolve(resultFor(text))
      }, ms)
    })
  }

  end(callback?: () => void): Promise<void> {
    this._ending = true
    callback?.()
    return Promise.resolve()
  }

  ref(): void {}
  unref(): void {}
}

function newPool(max = 10): Pool {
  return new Pool({
    Client: FakeClient as never,
    max,
    connectionTimeoutMillis: POSTGRES_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 0,
    onConnect: applySessionTimeouts
  } as never)
}

const entries = [
  { type: 'user', uuid: 'u-1', message: { role: 'user', content: 'oi' } },
  { type: 'custom-title', customTitle: 'Título', sessionId: 's-1' }
] as unknown as SessionStoreEntry[]

/** Roda um append pulando de timer em timer; devolve o tempo (falso) gasto. */
async function timedAppend(pool: Pool): Promise<{ elapsed: number; ok: boolean; error?: string }> {
  const store = createPostgresSessionStore(pool, 'conv-1')
  const started = Date.now()
  // O instante é lido NA HORA em que o append termina (o laço abaixo pode já
  // ter pulado para um timer seguinte, sem relação com ele).
  let outcome: { ok: boolean; error?: string; at: number } | null = null
  void store.append({ projectKey: 'p', sessionId: 's-1' }, entries).then(
    () => (outcome = { ok: true, at: Date.now() }),
    (error: unknown) =>
      (outcome = { ok: false, error: error instanceof Error ? error.message : String(error), at: Date.now() })
  )
  for (let step = 0; step < 10_000 && !outcome; step += 1) {
    if (vi.getTimerCount() === 0) await Promise.resolve()
    else await vi.advanceTimersToNextTimerAsync()
  }
  if (!outcome) throw new Error('o append ficou pendurado sem timer nenhum')
  const { at, ...rest } = outcome as { ok: boolean; error?: string; at: number }
  return { elapsed: at - started, ...rest }
}

beforeEach(() => {
  vi.useFakeTimers()
  sentTimeouts.length = 0
})
afterEach(() => {
  vi.useRealTimers()
})

describe('prazo único do append do espelho', () => {
  it('a conta: prazo de 45s, conexão + SET + consulta cabem numa tentativa, folga até os 60s do SDK', () => {
    expect(MIRROR_APPEND_RETRY_BUDGET_MS).toBe(45_000)
    expect(APPEND_CONNECT_BUDGET_MS).toBe(POSTGRES_CONNECT_TIMEOUT_MS + SESSION_SETUP_TIMEOUT_MS)
    expect(APPEND_ATTEMPT_MIN_MS).toBe(POSTGRES_CONNECT_TIMEOUT_MS + SESSION_SETUP_TIMEOUT_MS + POSTGRES_CALL_TIMEOUT_MS)
    expect(APPEND_ATTEMPT_MIN_MS).toBeLessThanOrEqual(MIRROR_APPEND_RETRY_BUDGET_MS)
    expect(60_000 - MIRROR_APPEND_RETRY_BUDGET_MS).toBeGreaterThanOrEqual(10_000)
  })

  it('cada consulta leva no máximo o que resta do prazo', () => {
    const deadline = new AppendDeadline(45_000)
    expect(deadline.queryTimeout()).toBe(POSTGRES_CALL_TIMEOUT_MS)
    vi.advanceTimersByTime(38_000)
    expect(deadline.queryTimeout()).toBe(7_000)
    vi.advanceTimersByTime(7_000)
    expect(() => deadline.queryTimeout()).toThrow(/prazo/)
  })

  it('pior caso: handshake 7,9s + SET do onConnect 9,9s + consultas lentas — termina no prazo, não em 58s', async () => {
    scenario = { connectMs: 7_900, setMs: 9_900, queryMs: 14_900 }
    const result = await timedAppend(newPool())
    expect(result).toMatchObject({ ok: false, error: 'Query read timeout' })
    expect(result.elapsed).toBeLessThanOrEqual(MIRROR_APPEND_RETRY_BUDGET_MS)
    // O SET contou: a 2ª consulta já não ganhou os 15s inteiros.
    const appendQueries = sentTimeouts.filter((sent) => !sent.text.startsWith('SET lock_timeout'))
    expect(sentTimeouts[0]).toMatchObject({ text: expect.stringMatching(/^SET lock_timeout/), timeout: SESSION_SETUP_TIMEOUT_MS })
    expect(appendQueries.at(-1)!.timeout).toBeLessThan(POSTGRES_CALL_TIMEOUT_MS)
  })

  it('pool que nunca entrega a conexão (timers internos não resolvem): o prazo corta por fora', async () => {
    scenario = { connectMs: 'hang', connectInvisible: true, setMs: 0, queryMs: 0 }
    const result = await timedAppend(newPool())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/timeout exceeded when trying to connect/)
    expect(result.elapsed).toBeLessThanOrEqual(MIRROR_APPEND_RETRY_BUDGET_MS)
  })

  it('pool cheio: esperas na fila repetidas não passam do prazo', async () => {
    scenario = { connectMs: 0, setMs: 0, queryMs: 0 }
    const pool = newPool(1)
    const held = pool.connect()
    await vi.advanceTimersByTimeAsync(1)
    await held
    const result = await timedAppend(pool)
    expect(result).toMatchObject({ ok: false, error: 'timeout exceeded when trying to connect' })
    expect(result.elapsed).toBeLessThanOrEqual(MIRROR_APPEND_RETRY_BUDGET_MS)
  })

  it('varredura: nenhuma combinação de atrasos passa do prazo, e toda consulta leva teto', async () => {
    const connects: Delay[] = [0, 4_000, 7_900, 'hang']
    const sets: Delay[] = [0, 5_000, 9_900, 'hang']
    const queries: Delay[] = [0, 5_000, 11_500, 14_900, 'hang']
    let worst = 0
    let runs = 0
    for (const connectMs of connects) {
      for (const setMs of sets) {
        for (const queryMs of queries) {
          for (const queryReset of [false, true]) {
            scenario = { connectMs, setMs, queryMs, queryReset }
            sentTimeouts.length = 0
            const result = await timedAppend(newPool())
            runs += 1
            worst = Math.max(worst, result.elapsed)
            expect(result.elapsed, JSON.stringify(scenario)).toBeLessThanOrEqual(MIRROR_APPEND_RETRY_BUDGET_MS)
            for (const sent of sentTimeouts) expect(sent.timeout, sent.text).toBeGreaterThan(0)
          }
        }
      }
    }
    expect(runs).toBe(160)
    console.info(`[append-deadline] ${runs} cenários, pior caso ${worst}ms (prazo ${MIRROR_APPEND_RETRY_BUDGET_MS}ms, SDK 60000ms)`)
  })
})
