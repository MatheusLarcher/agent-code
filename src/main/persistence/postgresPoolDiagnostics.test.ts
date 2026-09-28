// @vitest-environment node
// Pool real do pg-pool 3.14 com um Client de mentira: esgota as vagas e confere
// o que o diagnóstico grava quando um pedido morre em "timeout exceeded when
// trying to connect".
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { appendFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { instrumentPool, isPoolExhausted } from './postgresPoolDiagnostics'

class FakeClient extends EventEmitter {
  static nextPort = 50_000
  _queryable = true
  _ending = false
  processID = FakeClient.nextPort
  connection = { stream: { destroyed: false, readyState: 'open', localPort: FakeClient.nextPort++, remotePort: 6502 } }
  connect(callback: (error?: Error) => void): void {
    setImmediate(() => callback())
  }
  query(_text: unknown, _values?: unknown, callback?: (error: Error | undefined, result: unknown) => void): unknown {
    const result = { rows: [], rowCount: 0 }
    // pool.query usa a forma com callback; o código do app, a com promessa.
    if (typeof callback === 'function') return setImmediate(() => callback(undefined, result))
    return Promise.resolve(result)
  }
  end(callback?: () => void): Promise<void> {
    this._ending = true
    callback?.()
    return Promise.resolve()
  }
  ref(): void {}
  unref(): void {}
}

async function waitForFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (text) return text
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('o diagnóstico não foi gravado')
}

const files: string[] = []
afterEach(async () => {
  for (const file of files.splice(0)) await rm(file, { force: true })
})

describe('diagnóstico do pool esgotado', () => {
  it('grava contagens, cada cliente retirado (idade, último SQL, socket) e o pg_stat_activity', async () => {
    const file = join(tmpdir(), `pool-diag-${randomUUID()}.log`)
    files.push(file)
    const pool = new Pool({ Client: FakeClient as never, max: 2, connectionTimeoutMillis: 50 })
    const activity = [{ pid: 7, state: 'idle in transaction', query: 'SELECT 1' }]
    instrumentPool(pool, { logFile: async () => file, snapshot: async () => activity })

    const held = await pool.connect()
    await held.query('SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', ['segredo-que-nao-vai-pro-log'])
    const orphan = await pool.connect()
    // Vaga retirada cujo socket já morreu: o caso "pool cheio com 1 TCP só".
    ;(orphan as unknown as FakeClient).connection.stream.destroyed = true

    const failure = await pool.query('SELECT 2').catch((error: unknown) => error)
    expect(isPoolExhausted(failure)).toBe(true)

    const lines = (await waitForFile(file)).trim().split('\n')
    expect(lines).toHaveLength(1)
    const report = JSON.parse(lines[0])
    expect(report).toMatchObject({
      reason: 'connect',
      pid: process.pid,
      pool: { totalCount: 2, idleCount: 0, max: 2 },
      activity
    })
    expect(report.clients).toHaveLength(2)
    const [first, second] = report.clients
    expect(first).toMatchObject({
      state: 'checked-out',
      lastSql: 'SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE',
      socketDestroyed: false,
      queryable: true,
      remotePort: 6502
    })
    expect(first.checkoutAgeMs).toBeGreaterThanOrEqual(0)
    expect(second).toMatchObject({ state: 'checked-out', lastSql: null, socketDestroyed: true })
    // Valores das consultas nunca vão para o log.
    expect(lines[0]).not.toContain('segredo-que-nao-vai-pro-log')

    // No máximo um relatório por minuto: a segunda falha seguida não grava.
    await pool.connect().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1)

    held.release()
    orphan.release()
    await pool.end()
  })

  it('log acima de 5MB é rotacionado para .1 antes de gravar; até 5MB só acrescenta', async () => {
    const file = join(tmpdir(), `pool-diag-rot-${randomUUID()}.log`)
    files.push(file, `${file}.1`)
    const limit = 5 * 1024 * 1024
    let t = 0
    const pool = new Pool({ Client: FakeClient as never, max: 1, connectionTimeoutMillis: 50 })
    const diagnostics = instrumentPool(pool, { logFile: async () => file, now: () => t })

    // Exatamente 5MB: ainda não passa do limite, o relatório é acrescentado.
    await writeFile(file, 'x'.repeat(limit))
    await diagnostics.report('no-limite')
    expect((await stat(file)).size).toBeGreaterThan(limit)
    await expect(stat(`${file}.1`)).rejects.toMatchObject({ code: 'ENOENT' })

    // Passou de 5MB: o arquivo vira .1 e o relatório novo começa um arquivo limpo.
    t += 60_000
    await diagnostics.report('rotacao')
    const rotated = await readFile(`${file}.1`, 'utf8')
    expect(rotated.length).toBeGreaterThan(limit)
    expect(rotated).toContain('"reason":"no-limite"')
    const fresh = (await readFile(file, 'utf8')).trim().split('\n')
    expect(fresh).toHaveLength(1)
    expect(JSON.parse(fresh[0])).toMatchObject({ reason: 'rotacao' })

    // Uma nova rotação substitui o .1 anterior (no máximo ~10MB em disco).
    await appendFile(file, 'y'.repeat(limit))
    t += 60_000
    await diagnostics.report('segunda-rotacao')
    expect(await readFile(`${file}.1`, 'utf8')).toContain('"reason":"rotacao"')
    expect(await readFile(`${file}.1`, 'utf8')).not.toContain('"reason":"no-limite"')
    await pool.end()
  })

  it('não muda o comportamento do pool: connect por promessa e por callback seguem funcionando', async () => {
    const pool = new Pool({ Client: FakeClient as never, max: 1, connectionTimeoutMillis: 50 })
    instrumentPool(pool, { logFile: async () => null })
    const client = await pool.connect()
    client.release()
    await expect(pool.query('SELECT 1')).resolves.toMatchObject({ rowCount: 0 })
    await new Promise<void>((resolve, reject) =>
      pool.connect((error, other, done) => {
        if (error) return reject(error)
        expect(other).toBeDefined()
        done()
        resolve()
      })
    )
    await pool.end()
  })
})
