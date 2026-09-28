// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Cliente pg de mentira: `connect` segue o roteiro de `plan` (ok/falha) e o
 *  teste derruba o socket de um cliente vivo com `emit('error')`. */
const plan: Array<'ok' | 'fail'> = []
const clients: FakeClient[] = []

class FakeClient extends EventEmitter {
  ended = false
  constructor() {
    super()
    clients.push(this)
  }
  async connect(): Promise<void> {
    if ((plan.shift() ?? 'ok') === 'fail') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  }
  async query(config: string | { text: string }): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = typeof config === 'string' ? config : config.text
    if (sql.startsWith('SELECT change_id FROM installation_change_cursors')) return { rows: [{ change_id: 7 }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }
  async end(): Promise<void> {
    this.ended = true
  }
}

vi.mock('pg', () => ({ Client: FakeClient }))

const { PostgresChangeFeed, FEED_RECONNECT_DELAYS_MS } = await import('./postgresChangeFeed')

function feed() {
  const onOffline = vi.fn()
  const instance = new PostgresChangeFeed({}, 'install-1', vi.fn(), onOffline)
  return { instance, onOffline }
}

describe('PostgresChangeFeed: queda da conexão LISTEN', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    plan.length = 0
    clients.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it('socket morto (volta da suspensão) reconecta sem declarar o backend offline', async () => {
    const { instance, onOffline } = feed()
    await instance.start()
    expect(clients).toHaveLength(1)
    clients[0].emit('error', new Error('Connection terminated unexpectedly'))
    expect(clients[0].ended).toBe(true)
    await vi.advanceTimersByTimeAsync(FEED_RECONNECT_DELAYS_MS[0])
    expect(clients).toHaveLength(2)
    expect(clients[1].listenerCount('notification')).toBe(1)
    expect(onOffline).not.toHaveBeenCalled()
    await instance.close()
  })

  it('rede fora por mais tempo: só depois de esgotar as tentativas avisa offline, e uma vez só', async () => {
    const { instance, onOffline } = feed()
    await instance.start()
    plan.push(...FEED_RECONNECT_DELAYS_MS.map(() => 'fail' as const), 'fail', 'fail')
    clients[0].emit('error', new Error('read ECONNRESET'))
    // Tentativas 1..N-1 falham sem avisar.
    for (const delay of FEED_RECONNECT_DELAYS_MS.slice(0, -1)) {
      await vi.advanceTimersByTimeAsync(delay)
    }
    expect(onOffline).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(FEED_RECONNECT_DELAYS_MS.at(-1)!)
    expect(onOffline).toHaveBeenCalledTimes(1)
    // Continua tentando (o dono decide fechar); não repete o aviso.
    await vi.advanceTimersByTimeAsync(FEED_RECONNECT_DELAYS_MS.at(-1)! * 2)
    expect(onOffline).toHaveBeenCalledTimes(1)
    await instance.close()
  })

  it('uma reconexão bem-sucedida zera a contagem de falhas', async () => {
    const { instance, onOffline } = feed()
    await instance.start()
    plan.push('fail', 'fail', 'ok')
    clients[0].emit('error', new Error('read ECONNRESET'))
    await vi.advanceTimersByTimeAsync(FEED_RECONNECT_DELAYS_MS[0] + FEED_RECONNECT_DELAYS_MS[1] + FEED_RECONNECT_DELAYS_MS[2])
    const live = clients.at(-1)!
    expect(live.ended).toBe(false)
    // Nova queda: recomeça do primeiro degrau, sem herdar as falhas anteriores.
    plan.push('fail', 'fail', 'fail')
    live.emit('error', new Error('read ECONNRESET'))
    await vi.advanceTimersByTimeAsync(FEED_RECONNECT_DELAYS_MS[0] + FEED_RECONNECT_DELAYS_MS[1] + FEED_RECONNECT_DELAYS_MS[2])
    expect(onOffline).not.toHaveBeenCalled()
    await instance.close()
  })

  it('falha na abertura é do chamador: rejeita e não agenda reconexão', async () => {
    const { instance, onOffline } = feed()
    plan.push('fail')
    await expect(instance.start()).rejects.toThrow('ECONNREFUSED')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clients).toHaveLength(1)
    expect(onOffline).not.toHaveBeenCalled()
  })

  it('close() durante a espera cancela a reconexão', async () => {
    const { instance } = feed()
    await instance.start()
    clients[0].emit('error', new Error('read ECONNRESET'))
    await instance.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clients).toHaveLength(1)
  })
})
