import type { ClientBase, Pool, PoolClient } from 'pg'
import {
  APPEND_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  HOT_PATH_LOCK_TIMEOUT_MS,
  POSTGRES_CALL_TIMEOUT_MS,
  POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  POSTGRES_LOCK_TIMEOUT_MS,
  POSTGRES_STATEMENT_TIMEOUT_MS,
  rollbackOrDiscard,
  timedQuery
} from './postgresTimeouts'

/** Teto da própria configuração da sessão: três SETs numa ida ao servidor. */
export const SESSION_SETUP_TIMEOUT_MS = 10_000

export function sessionTimeoutsSql(): string {
  return [
    `SET lock_timeout = ${POSTGRES_LOCK_TIMEOUT_MS}`,
    `SET statement_timeout = ${POSTGRES_STATEMENT_TIMEOUT_MS}`,
    `SET idle_in_transaction_session_timeout = ${POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS}`
  ].join('; ')
}

/**
 * Aplica os tetos do servidor (ver postgresTimeouts.ts) por SET, logo depois de
 * conectar. Eles NÃO podem ir como parâmetro de startup: o PgBouncer, na
 * configuração padrão, recusa a conexão inteira com "unsupported startup
 * parameter: statement_timeout". Um SET passa por ele em pool_mode=session — o
 * único modo em que o app funciona (o LISTEN do change feed exige sessão).
 *
 * Uso: `onConnect` do pool (o pg-pool só entrega o cliente depois que isto
 * termina; se falhar, a conexão é descartada e o erro vai para quem pediu) e,
 * nos `Client` avulsos (LISTEN, maintenance), logo após o `connect()`.
 */
export async function applySessionTimeouts(client: Pick<ClientBase, 'query'>): Promise<void> {
  await client.query(timedQuery(sessionTimeoutsSql(), undefined, SESSION_SETUP_TIMEOUT_MS))
}

/** BEGIN de uma transação de caminho quente (renovação do lease) com o
 *  `lock_timeout` curto (HOT_PATH_LOCK_TIMEOUT_MS), abaixo do teto do cliente
 *  por consulta. Uma ida só ao servidor: consulta simples, sem valores. */
export function hotPathBeginSql(extra: string[] = []): string {
  return ['BEGIN', `SET LOCAL lock_timeout = ${HOT_PATH_LOCK_TIMEOUT_MS}`, ...extra].join('; ')
}

/** BEGIN do append do espelho: o de caminho quente + o
 *  `idle_in_transaction_session_timeout` curto (APPEND_IDLE_IN_TRANSACTION_TIMEOUT_MS). */
export function appendBeginSql(): string {
  return hotPathBeginSql([`SET LOCAL idle_in_transaction_session_timeout = ${APPEND_IDLE_IN_TRANSACTION_TIMEOUT_MS}`])
}

type HotPathQuery = <R extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values?: unknown[]
) => Promise<{ rows: R[]; rowCount: number | null }>

/**
 * Transação curta de caminho quente: cada consulta (BEGIN e COMMIT inclusive)
 * com `query_timeout` de POSTGRES_CALL_TIMEOUT_MS e o `lock_timeout` da
 * transação em HOT_PATH_LOCK_TIMEOUT_MS, bem abaixo — numa espera por trava o
 * servidor corta primeiro (55P03), o ROLLBACK funciona e a conexão volta ao
 * pool. Conexão que caiu ou travou é descartada.
 */
export async function hotPathTransaction<T>(pool: Pick<Pool, 'connect'>, fn: (query: HotPathQuery) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect()
  const query = ((text: string, values?: unknown[]) =>
    client.query(timedQuery(text, values, POSTGRES_CALL_TIMEOUT_MS))) as unknown as HotPathQuery
  let discard: Error | undefined
  try {
    await query(hotPathBeginSql())
    const value = await fn(query)
    await query('COMMIT')
    return value
  } catch (error) {
    discard = await rollbackOrDiscard({ query: query as unknown as PoolClient['query'] }, error)
    throw error
  } finally {
    client.release(discard)
  }
}
