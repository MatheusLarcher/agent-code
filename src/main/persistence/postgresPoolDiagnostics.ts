import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Client, type ClientConfig, type Pool, type PoolClient } from 'pg'

/**
 * Diagnóstico do esgotamento do pool ("timeout exceeded when trying to
 * connect"). O mecanismo reproduzido (consulta sem teto segurando a vaga) deixa
 * os sockets abertos, mas uma medição de campo viu só 1 conexão TCP com o pool
 * cheio — e não se sabe como ela foi feita. Em vez de adivinhar, na próxima vez
 * que acontecer isto grava em `<userData>/postgres-pool-diagnostics.log`:
 *
 * - totalCount / idleCount / waitingCount do pool;
 * - para cada cliente do pool: se está retirado, ocioso ou conectando; idade do
 *   checkout; o último SQL (só o texto, nunca os valores) e há quanto tempo foi
 *   enviado; se o socket já foi destruído; porta local/remota (para cruzar com
 *   `Get-NetTCPConnection -OwningProcess <pid> -RemotePort <porta>`); o pid do
 *   backend;
 * - um retrato de `pg_stat_activity` (application_name='agent-code'), tirado
 *   por uma conexão avulsa, fora do pool que está cheio.
 *
 * No máximo um relatório por minuto: com o pool cheio o erro se repete em
 * todo pedido.
 */

export const POOL_DIAGNOSTICS_FILE = 'postgres-pool-diagnostics.log'
export const POOL_DIAGNOSTICS_INTERVAL_MS = 60_000
const MAX_LOG_BYTES = 5 * 1024 * 1024
const SQL_PREVIEW_CHARS = 200
const SNAPSHOT_TIMEOUT_MS = 5_000

export function isPoolExhausted(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout exceeded when trying to connect'
}

interface Usage {
  checkedOutAt: number | null
  lastSql: string | null
  lastSqlAt: number | null
}

/** Campos internos do `pg` 8.23 / `pg-pool` 3.14 lidos só para o relatório. */
interface ClientInternals {
  processID?: number | null
  _queryable?: boolean
  _ending?: boolean
  _ended?: boolean
  connection?: {
    stream?: { destroyed?: boolean; readyState?: string; localPort?: number; remotePort?: number }
  }
}
interface PoolInternals {
  _clients?: unknown[]
  _idle?: { client: unknown }[]
  options?: { max?: number }
}

export interface PoolDiagnosticsOptions {
  /** Arquivo do log; `null` = só console. Padrão: userData do Electron. */
  logFile?: () => Promise<string | null>
  /** Retrato de `pg_stat_activity` por conexão avulsa. */
  snapshot?: () => Promise<unknown>
  now?: () => number
}

export interface PoolDiagnostics {
  /** Grava um relatório agora (respeitando o intervalo mínimo). */
  report(reason: string): Promise<void>
}

function sqlText(arg: unknown): string | null {
  const text = typeof arg === 'string' ? arg : (arg as { text?: unknown } | null)?.text
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, SQL_PREVIEW_CHARS) : null
}

export async function defaultPoolDiagnosticsFile(): Promise<string | null> {
  const override = process.env.AGENT_CODE_POOL_DIAGNOSTICS_FILE
  if (override) return override
  // Fora do Electron (testes, scripts) não há userData: só console.
  if (!process.versions.electron) return null
  try {
    const { app } = await import('electron')
    return join(app.getPath('userData'), POOL_DIAGNOSTICS_FILE)
  } catch {
    return null
  }
}

/** `pg_stat_activity` das sessões do app, por uma conexão avulsa e curta. */
export async function pgStatActivitySnapshot(config: ClientConfig): Promise<unknown> {
  const client = new Client({
    ...config,
    application_name: 'agent-code-diagnostics',
    connectionTimeoutMillis: SNAPSHOT_TIMEOUT_MS,
    query_timeout: SNAPSHOT_TIMEOUT_MS
  })
  client.on('error', () => undefined)
  try {
    await client.connect()
    const result = await client.query(
      `SELECT pid, state, wait_event_type, wait_event, backend_start, xact_start, query_start,
              state_change, client_addr::text AS client_addr, client_port, left(query, ${SQL_PREVIEW_CHARS}) AS query
       FROM pg_stat_activity WHERE application_name = 'agent-code' ORDER BY backend_start`
    )
    return result.rows
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  } finally {
    await client.end().catch(() => undefined)
  }
}

async function writeLine(file: string, line: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const size = await stat(file).then((info) => info.size, () => 0)
  if (size > MAX_LOG_BYTES) await rename(file, `${file}.1`).catch(() => undefined)
  await appendFile(file, `${line}\n`, 'utf8')
}

/**
 * Liga o diagnóstico num pool: acompanha checkout/último SQL de cada cliente e,
 * quando um pedido falha com o pool cheio, grava o relatório. Não muda o
 * comportamento do pool — o erro continua indo para quem pediu.
 */
export function instrumentPool(pool: Pool, options: PoolDiagnosticsOptions = {}): PoolDiagnostics {
  const now = options.now ?? Date.now
  const logFile = options.logFile ?? defaultPoolDiagnosticsFile
  const usage = new WeakMap<object, Usage>()
  let lastReportAt = Number.NEGATIVE_INFINITY
  let reporting = false

  const usageOf = (client: object): Usage => {
    let entry = usage.get(client)
    if (!entry) {
      entry = { checkedOutAt: null, lastSql: null, lastSqlAt: null }
      usage.set(client, entry)
    }
    return entry
  }

  pool.on('connect', (client: PoolClient) => {
    const original = client.query
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const entry = usageOf(client)
      entry.lastSql = sqlText(args[0])
      entry.lastSqlAt = now()
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    } as typeof client.query
  })
  pool.on('acquire', (client: PoolClient) => {
    usageOf(client).checkedOutAt = now()
  })
  pool.on('release', (_error: Error | undefined, client: PoolClient) => {
    usageOf(client).checkedOutAt = null
  })

  function describeClients(): unknown[] {
    const internals = pool as unknown as PoolInternals
    const idle = new Set((internals._idle ?? []).map((item) => item.client))
    const at = now()
    return (internals._clients ?? []).map((raw) => {
      const client = raw as ClientInternals
      const entry = usage.get(raw as object)
      const stream = client.connection?.stream
      return {
        state: idle.has(raw) ? 'idle' : entry?.checkedOutAt != null ? 'checked-out' : 'connecting',
        checkoutAgeMs: entry?.checkedOutAt != null ? at - entry.checkedOutAt : null,
        lastSql: entry?.lastSql ?? null,
        lastSqlAgeMs: entry?.lastSqlAt != null ? at - entry.lastSqlAt : null,
        backendPid: client.processID ?? null,
        socketDestroyed: stream?.destroyed ?? null,
        socketState: stream?.readyState ?? null,
        localPort: stream?.localPort ?? null,
        remotePort: stream?.remotePort ?? null,
        queryable: client._queryable ?? null,
        ending: client._ending ?? null,
        ended: client._ended ?? null
      }
    })
  }

  async function report(reason: string): Promise<void> {
    if (reporting || now() - lastReportAt < POOL_DIAGNOSTICS_INTERVAL_MS) return
    reporting = true
    lastReportAt = now()
    try {
      const entry = {
        at: new Date(now()).toISOString(),
        reason,
        pid: process.pid,
        pool: {
          totalCount: pool.totalCount,
          idleCount: pool.idleCount,
          waitingCount: pool.waitingCount,
          max: (pool as unknown as PoolInternals).options?.max ?? null
        },
        clients: describeClients(),
        activity: options.snapshot ? await options.snapshot() : null
      }
      const line = JSON.stringify(entry)
      console.warn(`[postgres] pool esgotado (${reason}): ${line.slice(0, 500)}`)
      const file = await logFile()
      if (file) await writeLine(file, line)
    } catch (error) {
      console.error('[postgres] falha ao gravar o diagnóstico do pool:', error)
    } finally {
      reporting = false
    }
  }

  // `pool.query` também passa por aqui (chama `this.connect(cb)`).
  const connect = pool.connect.bind(pool) as (cb?: (...args: unknown[]) => void) => unknown
  pool.connect = function (cb?: (error: unknown, ...rest: unknown[]) => void) {
    if (typeof cb === 'function') {
      return connect((error: unknown, ...rest: unknown[]) => {
        if (isPoolExhausted(error)) void report('connect')
        cb(error, ...rest)
      })
    }
    return (connect() as Promise<PoolClient>).catch((error: unknown) => {
      if (isPoolExhausted(error)) void report('connect')
      throw error
    })
  } as typeof pool.connect

  return { report }
}
