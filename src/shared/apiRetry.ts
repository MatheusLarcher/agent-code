/**
 * Nova tentativa da API agendada pelo CLI (`system/api_retry` do SDK): o estado
 * que o main publica (evento `api-retry`) e o texto que o PC (faixa "trabalhando")
 * e o celular (linha ao vivo) mostram. Puro: o relógio vem de quem chama.
 */

export interface ApiRetryState {
  /** Tentativa que vai rodar (1 = a primeira nova tentativa). */
  attempt: number
  maxRetries: number
  /** Epoch ms em que o CLI tenta de novo. */
  retryAt: number
  /** Status HTTP da falha; null = sem resposta (timeout, conexão). */
  status: number | null
  /** Código do erro do SDK (`overloaded`, `rate_limit`, `server_error`…). */
  error: string
}

/** O motivo, pelo código do SDK e, na falta dele, pelo status HTTP. */
function retryCause(state: ApiRetryState): string {
  const { error, status } = state
  if (error === 'overloaded' || status === 529) return 'API sobrecarregada'
  if (error === 'rate_limit' || status === 429) return 'Limite da API'
  if (error === 'server_error' || (status !== null && status >= 500)) {
    return status !== null ? `Erro no servidor da API (${status})` : 'Erro no servidor da API'
  }
  if (status === null) return 'Sem resposta da API'
  return 'Falha na API'
}

/** "API sobrecarregada · nova tentativa em 12 s (3/10)"; passado o prazo, "· tentando de novo (3/10)". */
export function apiRetryText(state: ApiRetryState, now: number): string {
  const count = `(${state.attempt}/${state.maxRetries})`
  const left = Math.ceil((state.retryAt - now) / 1000)
  const when = left > 0 ? `nova tentativa em ${left} s ${count}` : `tentando de novo ${count}`
  return `${retryCause(state)} · ${when}`
}
