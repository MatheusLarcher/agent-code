import type { TypeSafePauseStatus } from '../../shared/typesafePause'

/**
 * A pausa do TypeSafe (ideia do Nexos 0.6.1): quando o serviço recusa a chave
 * ou cai, parar de perguntar por um tempo e seguir direto com o par padrão, em
 * vez de fazer TODA conversa nova esperar o timeout.
 *
 * - 401/403 → pausa na hora (a chave não vai passar a valer sozinha).
 * - 429 → pausa pelo `Retry-After`, quando vem; senão, o tempo padrão.
 * - timeout, rede, 5xx → pausa depois de 2 falhas SEGUIDAS.
 * - Salvar outra chave (ou religar o modo) sai da pausa na hora.
 */

/** Tempo da pausa. */
export const TYPESAFE_PAUSE_MS = 10 * 60_000
/** Falhas transitórias seguidas até pausar. */
export const TYPESAFE_FAILURES_TO_PAUSE = 2
/** Teto do TypeSafe no caminho que segura o envio do usuário. */
export const TYPESAFE_BLOCKING_TIMEOUT_MS = 3_000

type FailureKind = 'auth' | 'rate' | 'transient' | 'ignore'

/** Classifica o erro do `@typesafe-ai/sdk` pelo status/nome, sem `instanceof`. */
export function classifyTypeSafeFailure(error: unknown): { kind: FailureKind; retryAfterMs?: number } {
  const e = (error ?? {}) as { status?: unknown; name?: unknown; retryAfterMs?: unknown }
  const name = typeof e.name === 'string' ? e.name : ''
  // Cancelado por quem chamou: não diz nada sobre o serviço.
  if (name === 'APIUserAbortError' || name === 'AbortError') return { kind: 'ignore' }
  const status = typeof e.status === 'number' ? e.status : undefined
  if (status === 401 || status === 403) return { kind: 'auth' }
  if (status === 429) {
    const retryAfterMs = typeof e.retryAfterMs === 'number' && e.retryAfterMs > 0 ? e.retryAfterMs : undefined
    return { kind: 'rate', ...(retryAfterMs ? { retryAfterMs } : {}) }
  }
  if (status !== undefined && status >= 500) return { kind: 'transient' }
  // Sem status: timeout ou falha de rede (APITimeoutError/APIConnectionError).
  if (status === undefined) return { kind: 'transient' }
  // Outros 4xx (400, 404, 422): pedido nosso malformado, não serviço fora.
  return { kind: 'ignore' }
}

const REASONS: Record<Exclude<FailureKind, 'ignore'>, string> = {
  auth: 'key recusada',
  rate: 'limite de uso do serviço',
  transient: 'serviço sem resposta'
}

export function createTypeSafePause(options: { now?: () => number; onPause?: (status: TypeSafePauseStatus) => void } = {}) {
  const now = options.now ?? Date.now
  let failures = 0
  let pausedUntil: number | null = null
  let reason: string | null = null
  // A chave em uso quando a pausa começou: outra chave sai da pausa sozinha.
  let keyAtPause: string | null = null
  let onPause = options.onPause

  function pause(kind: Exclude<FailureKind, 'ignore'>, key: string | null, ms: number): void {
    pausedUntil = now() + ms
    reason = REASONS[kind]
    keyAtPause = key
    failures = 0
    // Aviso uma vez só: é aqui, ao ENTRAR na pausa, e nunca durante ela.
    onPause?.({ pausedUntil, reason })
  }

  return {
    /** Está em pausa para esta chave? Pausa vencida ou chave trocada = liberado. */
    isPaused(key: string | null): boolean {
      if (pausedUntil === null) return false
      if (now() >= pausedUntil || key !== keyAtPause) {
        this.reset()
        return false
      }
      return true
    },

    recordSuccess(): void {
      failures = 0
    },

    recordFailure(error: unknown, key: string | null): void {
      const { kind, retryAfterMs } = classifyTypeSafeFailure(error)
      if (kind === 'ignore') return
      if (kind === 'auth') return pause(kind, key, TYPESAFE_PAUSE_MS)
      if (kind === 'rate') return pause(kind, key, retryAfterMs ?? TYPESAFE_PAUSE_MS)
      failures += 1
      if (failures >= TYPESAFE_FAILURES_TO_PAUSE) pause(kind, key, TYPESAFE_PAUSE_MS)
    },

    /** Chave nova salva ou modo religado: volta a consultar na hora. */
    reset(): void {
      failures = 0
      pausedUntil = null
      reason = null
      keyAtPause = null
    },

    status(): TypeSafePauseStatus {
      if (pausedUntil !== null && now() >= pausedUntil) this.reset()
      return { pausedUntil, reason }
    },

    setOnPause(listener: ((status: TypeSafePauseStatus) => void) | undefined): void {
      onPause = listener
    }
  }
}

/** A pausa do processo, compartilhada por todo chamador do TypeSafe. */
export const typeSafePause = createTypeSafePause()
