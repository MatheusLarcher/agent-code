// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { classifyClaudeObserverFailure } from './observerQuery'

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
