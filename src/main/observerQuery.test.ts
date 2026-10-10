// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  frames: [] as unknown[],
  /** Por conta (env CLAUDE_CONFIG_DIR): os frames daquela conta; vence `frames`. */
  byAccount: null as Record<string, unknown[]> | null,
  envs: [] as Array<string | undefined>
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { env?: NodeJS.ProcessEnv } }) => {
    const account = options.env?.CLAUDE_CONFIG_DIR
    sdk.envs.push(account)
    const frames = sdk.byAccount && account ? sdk.byAccount[account] ?? [] : sdk.frames
    return (async function* () {
      for (const frame of frames) yield frame
    })()
  }
}))

import { classifyClaudeObserverFailure, runObserverAttempt, setClaudeObserverAccounts } from './observerQuery'

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

describe('runObserverAttempt — troca de conta no estouro, como o agente principal', () => {
  const LIMIT = "You've hit your session limit · resets 3am"
  const exhaustedFrame = { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: LIMIT }] } }

  function accounts(order: string[]) {
    const marked: string[] = []
    setClaudeObserverAccounts({
      pick: async (_conv, _model, exclude) => {
        const id = order.find((candidate) => !exclude.has(candidate) && !marked.includes(candidate))
        return id ? { id, env: { CLAUDE_CONFIG_DIR: id } } : null
      },
      markExhausted: (id) => {
        marked.push(id)
      }
    })
    return marked
  }

  beforeEach(() => {
    sdk.envs = []
  })

  afterEach(() => {
    setClaudeObserverAccounts(null)
    sdk.byAccount = null
    sdk.envs = []
  })

  it('a conta da conversa estourou: marca, segue para a próxima e responde por ela', async () => {
    const marked = accounts(['A', 'B'])
    sdk.byAccount = { A: [exhaustedFrame], B: [answer('veredito')] }
    expect(await runObserverAttempt({ prompt: 'p', model: 'm', provider: 'claude', conversationId: 'c' }))
      .toEqual({ provider: 'claude', state: 'completed', text: 'veredito' })
    expect(sdk.envs).toEqual(['A', 'B'])
    expect(marked).toEqual(['A'])
  })

  it('todas estouradas: falha com claude_plan (o PO e o memorista seguem para a Luna)', async () => {
    const marked = accounts(['A', 'B'])
    sdk.byAccount = { A: [exhaustedFrame], B: [exhaustedFrame] }
    expect(await runObserverAttempt({ prompt: 'p', model: 'm', provider: 'claude' }))
      .toEqual({ provider: 'claude', state: 'failed', reason: 'claude_plan' })
    expect(marked).toEqual(['A', 'B'])
  })

  it('erro que não é limite (sobrecarga) não troca de conta', async () => {
    const marked = accounts(['A', 'B'])
    sdk.byAccount = { A: [answer('API Error: 529 overloaded', 'overloaded')], B: [answer('não devia rodar')] }
    expect(await runObserverAttempt({ prompt: 'p', model: 'm', provider: 'claude' })).toEqual({ provider: 'claude', state: 'failed' })
    expect(sdk.envs).toEqual(['A'])
    expect(marked).toEqual([])
  })

  it('env explícito (Luna, quem já escolheu a conta) roda uma vez só', async () => {
    accounts(['A', 'B'])
    sdk.byAccount = { X: [exhaustedFrame] }
    await runObserverAttempt({ prompt: 'p', model: 'm', provider: 'claude', env: { CLAUDE_CONFIG_DIR: 'X' } })
    expect(sdk.envs).toEqual(['X'])
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
