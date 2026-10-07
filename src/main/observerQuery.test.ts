// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ frames: [] as unknown[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const frame of sdk.frames) yield frame
    })()
}))

import { classifyClaudeObserverFailure, runObserverAttempt } from './observerQuery'

const answer = (text: string, error?: string) => ({ type: 'assistant', ...(error ? { error } : {}), message: { content: [{ type: 'text', text }] } })
const attempt = (frames: unknown[]) => {
  sdk.frames = frames
  return runObserverAttempt({ prompt: 'p', model: 'm', provider: 'claude' })
}

describe('runObserverAttempt', () => {
  it('a resposta do modelo vira o texto', async () => {
    expect(await attempt([answer('tudo certo')])).toEqual({ provider: 'claude', state: 'completed', text: 'tudo certo' })
  })

  it('o frame de erro do SDK (sem login) não vira resposta: falha com o motivo', async () => {
    const frames = [answer('Not logged in · Please run /login', 'authentication_failed'), { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }]
    expect(await attempt(frames)).toEqual({ provider: 'claude', state: 'failed', reason: 'claude_auth' })
  })

  it('erro sem motivo de failover (sobrecarga) também não vira resposta', async () => {
    expect(await attempt([answer('API Error: 529 overloaded', 'overloaded')])).toEqual({ provider: 'claude', state: 'failed' })
  })

  it('a resposta cortada em max_output_tokens continua sendo resposta', async () => {
    expect(await attempt([answer('resposta cortada', 'max_output_tokens')])).toEqual({ provider: 'claude', state: 'completed', text: 'resposta cortada' })
  })
})

describe('classifyClaudeObserverFailure', () => {
  it.each([
    [{ type: 'assistant', error: 'billing_error' }, 'claude_plan'],
    [{ type: 'assistant', error: 'account_on_hold' }, 'claude_plan'],
    [{ type: 'assistant', error: 'authentication_failed' }, 'claude_auth'],
    [{ type: 'assistant', error: 'oauth_org_not_allowed' }, 'claude_authorization']
  ] as const)('maps only explicit current SDK assistant error %#', (failure, reason) => {
    expect(classifyClaudeObserverFailure(failure)).toBe(reason)
  })

  it.each([
    { status: 401 },
    { status: 403 },
    { status: 429 },
    { message: 'usage limit reached' },
    { type: 'assistant', error: 'rate_limit' },
    { type: 'assistant', error: 'account_on_hold after text' },
    { error: 'billing_error' },
    { code: 'usage_exhausted' },
    { type: 'api_retry', error: 'authentication_failed' },
    new Error('authentication failed'),
    undefined
  ])('does not infer a failover reason from ambiguous failure %#', (failure) => {
    expect(classifyClaudeObserverFailure(failure)).toBeUndefined()
  })
})
