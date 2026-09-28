import { StorageError } from './types'

/**
 * Falhas de CONEXÃO com o PostgreSQL — a rede caiu, o servidor reiniciou, o
 * socket morreu na suspensão. Repetir resolve assim que a rede volta. Erro de
 * SQL, de permissão, de dado inválido ou de pool encerrado NÃO entra: repetir
 * não muda nada e só atrasaria a falha que precisa aparecer.
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  // admin_shutdown / crash_shutdown / cannot_connect_now: servidor reiniciando
  // ou a conexão derrubada por pg_terminate_backend.
  '57P01',
  '57P02',
  '57P03'
])

/** Mensagens do `pg`/`pg-pool` que chegam sem `code`. */
const TRANSIENT_MESSAGES = [
  'timeout exceeded when trying to connect',
  'connection terminated',
  'connection timeout',
  'connection ended unexpectedly',
  'client has encountered a connection error and is not queryable'
]

/** StorageErrors do provisionamento que também são só "não alcancei o banco". */
const TRANSIENT_STORAGE_CODES = new Set(['CONNECTION_TIMEOUT', 'CONNECTION_REFUSED', 'HOST_UNREACHABLE', 'STORAGE_OFFLINE'])

export function isTransientPostgresError(error: unknown): boolean {
  let current: unknown = error
  // O `pg` às vezes embrulha a causa real; três níveis bastam e evitam ciclo.
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    if (current instanceof StorageError) return current.retryable && TRANSIENT_STORAGE_CODES.has(current.code)
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && (TRANSIENT_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code))) return true
    const message = current instanceof Error ? current.message.toLowerCase() : ''
    if (TRANSIENT_MESSAGES.some((fragment) => message.includes(fragment))) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * PRAZO ÚNICO de UM `append` do espelho, contado do início da chamada; todas
 * as tentativas descontam dele (postgresAppendDeadline.ts). O SDK dá 60s por
 * chamada e NÃO repete um timeout dele (a chamada em voo ainda pode gravar),
 * então o append precisa terminar, com sucesso ou erro, antes disso.
 *
 * Pior caso real, com tudo o que uma tentativa pode esperar:
 * - conexão: até 8s (POSTGRES_CONNECT_TIMEOUT_MS: fila por vaga ou handshake)
 *   + até 10s do SET no `onConnect` (SESSION_SETUP_TIMEOUT_MS) — o pg-pool zera
 *   o timer de 8s antes de chamar o `onConnect`, e uma espera na fila soma outro
 *   timer de 8s. Por isso o `pool.connect()` corre contra min(18s, o que resta)
 *   por fora do pg-pool, e nenhum desses timers internos conta;
 * - consultas: cada uma (ROLLBACK inclusive) com `query_timeout` =
 *   min(15s, o que resta) — POSTGRES_CALL_TIMEOUT_MS nunca passa do prazo;
 * - uma tentativa só COMEÇA se o que resta cobre conexão + SET + uma consulta
 *   inteira (8 + 10 + 15 = 33s), então a última começa até 12s.
 * Resultado: o append termina em no máximo 45s (+ o custo de CPU de rejeitar),
 * com 15s de folga até os 60s do SDK. O teto geral de 130s
 * (POSTGRES_QUERY_TIMEOUT_MS) NÃO vale para o append.
 */
export const MIRROR_APPEND_RETRY_BUDGET_MS = 45_000
export const MIRROR_APPEND_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const

export interface TransientRetryOptions {
  budgetMs?: number
  /** Instante absoluto (relógio de `now`) em que o orçamento acaba. Padrão:
   *  início + `budgetMs`. */
  deadlineAt?: number
  /** Uma tentativa nova só começa se, depois da espera, ainda sobrar isto até
   *  o prazo — o tempo que uma tentativa pode levar no pior caso. */
  attemptMinMs?: number
  delaysMs?: readonly number[]
  /** Pode repetir ESTE erro? Padrão: `isTransientPostgresError`. */
  isRetryable?: (error: unknown) => boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Roda `fn` e repete com backoff enquanto a falha for transitória e couber no
 *  orçamento. Uma nova tentativa só começa se a espera + `attemptMinMs` ainda
 *  cabem antes do prazo. */
export async function withTransientRetry<T>(fn: (attempt: number) => Promise<T>, options: TransientRetryOptions = {}): Promise<T> {
  const budget = options.budgetMs ?? MIRROR_APPEND_RETRY_BUDGET_MS
  const delays = options.delaysMs ?? MIRROR_APPEND_RETRY_DELAYS_MS
  const retryable = options.isRetryable ?? isTransientPostgresError
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const deadlineAt = options.deadlineAt ?? now() + budget
  const attemptMin = options.attemptMinMs ?? 0
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      if (!retryable(error)) throw error
      const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0
      if (now() + delay + attemptMin >= deadlineAt) throw error
      options.onRetry?.(error, attempt + 1, delay)
      await sleep(delay)
    }
  }
}
