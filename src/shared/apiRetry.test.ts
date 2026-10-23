import { describe, expect, it } from 'vitest'
import { apiRetryText, type ApiRetryState } from './apiRetry'

const NOW = 1_700_000_000_000
const state = (over: Partial<ApiRetryState> = {}): ApiRetryState => ({
  attempt: 3,
  maxRetries: 10,
  retryAt: NOW + 12_000,
  status: 529,
  error: 'overloaded',
  ...over
})

describe('apiRetryText', () => {
  it('motivo, segundos que faltam e a contagem de tentativas', () => {
    expect(apiRetryText(state(), NOW)).toBe('API sobrecarregada · nova tentativa em 12 s (3/10)')
    expect(apiRetryText(state(), NOW + 11_500)).toBe('API sobrecarregada · nova tentativa em 1 s (3/10)')
  })

  it('passado o prazo: "tentando de novo"', () => {
    expect(apiRetryText(state(), NOW + 12_000)).toBe('API sobrecarregada · tentando de novo (3/10)')
    expect(apiRetryText(state(), NOW + 60_000)).toBe('API sobrecarregada · tentando de novo (3/10)')
  })

  it('o motivo pelo código do SDK ou pelo status HTTP', () => {
    expect(apiRetryText(state({ error: 'unknown', status: 529 }), NOW)).toMatch(/^API sobrecarregada ·/)
    expect(apiRetryText(state({ error: 'rate_limit', status: 429 }), NOW)).toMatch(/^Limite da API ·/)
    expect(apiRetryText(state({ error: 'unknown', status: 429 }), NOW)).toMatch(/^Limite da API ·/)
    expect(apiRetryText(state({ error: 'server_error', status: 500 }), NOW)).toMatch(/^Erro no servidor da API \(500\) ·/)
    expect(apiRetryText(state({ error: 'unknown', status: 503 }), NOW)).toMatch(/^Erro no servidor da API \(503\) ·/)
    expect(apiRetryText(state({ error: 'unknown', status: null }), NOW)).toMatch(/^Sem resposta da API ·/)
    expect(apiRetryText(state({ error: 'invalid_request', status: 400 }), NOW)).toMatch(/^Falha na API ·/)
  })

  it('erro do servidor sem status não mostra "(null)"', () => {
    expect(apiRetryText(state({ error: 'server_error', status: null }), NOW)).toMatch(/^Erro no servidor da API ·/)
  })
})
