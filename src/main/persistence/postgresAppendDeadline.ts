import type { Pool, PoolClient } from 'pg'
import { MIRROR_APPEND_RETRY_BUDGET_MS } from './postgresRetry'
import { SESSION_SETUP_TIMEOUT_MS } from './postgresSessionSetup'
import { POSTGRES_CALL_TIMEOUT_MS, POSTGRES_CONNECT_TIMEOUT_MS, timedQuery } from './postgresTimeouts'

/**
 * Prazo único de um `append` do espelho (ver MIRROR_APPEND_RETRY_BUDGET_MS em
 * postgresRetry.ts para a conta do pior caso). Cada tentativa desconta dele:
 * a conexão corre contra o que resta e cada consulta leva
 * `query_timeout` = min(teto por consulta, o que resta).
 */

/** Conexão (vaga ou handshake) + SET do `onConnect`: o máximo que o
 *  `pool.connect()` pode levar numa tentativa. */
export const APPEND_CONNECT_BUDGET_MS = POSTGRES_CONNECT_TIMEOUT_MS + SESSION_SETUP_TIMEOUT_MS

/** Uma tentativa só começa se o que resta cobre conexão + SET + uma consulta
 *  inteira. */
export const APPEND_ATTEMPT_MIN_MS = APPEND_CONNECT_BUDGET_MS + POSTGRES_CALL_TIMEOUT_MS

/** Mensagem com o fragmento que `isTransientPostgresError` reconhece: não
 *  alcançar uma conexão no prazo é "banco fora", e repetir pode resolver. */
export const APPEND_CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect (prazo do append do espelho)'

export class AppendDeadlineExceededError extends Error {
  constructor(budgetMs: number) {
    super(`SessionStore.append: prazo de ${budgetMs}ms esgotado`)
    this.name = 'AppendDeadlineExceededError'
  }
}

export class AppendDeadline {
  readonly at: number

  constructor(
    readonly budgetMs: number = MIRROR_APPEND_RETRY_BUDGET_MS,
    private readonly now: () => number = Date.now
  ) {
    this.at = now() + budgetMs
  }

  remaining(): number {
    return this.at - this.now()
  }

  /** `query_timeout` da próxima consulta. Sem tempo nenhum, falha sem enviar. */
  queryTimeout(cap: number = POSTGRES_CALL_TIMEOUT_MS): number {
    const left = this.remaining()
    if (left <= 0) throw new AppendDeadlineExceededError(this.budgetMs)
    return Math.min(cap, Math.ceil(left))
  }
}

export type Queryable = Pick<PoolClient, 'query'>

/** O mesmo cliente, com toda consulta limitada pelo prazo. */
export function deadlineQueryable(client: Queryable, deadline: AppendDeadline): Queryable {
  return {
    query: (async (text: string, values?: unknown[]) =>
      client.query(timedQuery(text, values, deadline.queryTimeout()))) as unknown as PoolClient['query']
  }
}

/**
 * `pool.connect()` limitado a min(conexão + SET, o que resta), POR FORA do
 * pg-pool: os timers dele não somam um teto só (a espera na fila e o handshake
 * têm 8s cada, e o `onConnect` começa depois de o timer do handshake ser
 * zerado). Se o pool entregar a conexão depois que desistimos, ela volta ao
 * pool na hora.
 */
export async function connectWithin(pool: Pool, deadline: AppendDeadline): Promise<PoolClient> {
  const limit = Math.min(APPEND_CONNECT_BUDGET_MS, deadline.remaining())
  if (limit <= 0) throw new AppendDeadlineExceededError(deadline.budgetMs)
  const pending = pool.connect()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error(APPEND_CONNECT_TIMEOUT_MESSAGE))
    }, limit)
  })
  try {
    return await Promise.race([pending, timeout])
  } catch (error) {
    if (timedOut) {
      pending.then(
        (client) => client.release(),
        () => undefined
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
