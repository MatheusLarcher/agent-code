// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserController } from './browserController'
import type { RestartActivity } from './appRestart'

const runtime = vi.hoisted(() => ({
  appRestart: undefined as undefined | { register: ReturnType<typeof vi.fn> }
}))
vi.mock('./appRestartRuntime', () => runtime)
vi.mock('./config', () => ({ loadConfig: () => ({ windowsControlEnabled: false }) }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ dir: '', memoriesDir: '', skillsDir: '' }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => false }))
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: vi.fn(), FAST_MODE_TOKEN_SUFFIX: '+fast' }))

import { AgentSession } from './agentSession'

function session(convId: string): AgentSession {
  return new AgentSession({ convId, cwd: '/test' }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn())
}

beforeEach(() => { runtime.appRestart = undefined })

describe('AgentSession initialization with the restart coordinator', () => {
  it('constructs and registers each conversation with initialized activity', () => {
    const register = vi.fn((_id: string, _read: () => RestartActivity) => ({ request: vi.fn(), remove: vi.fn() }))
    runtime.appRestart = { register }

    const first = session('first')
    const second = session('second')

    expect(register.mock.calls.map(([id]) => id)).toEqual(['first', 'second'])
    const readFirst = register.mock.calls[0][1] as () => RestartActivity
    const readSecond = register.mock.calls[1][1] as () => RestartActivity
    expect(readFirst()).toEqual(first.restartActivity())
    expect(readSecond()).toEqual(second.restartActivity())
    // Só aberta, sem mensagem: não é trabalho — o CLI só emite `init` no primeiro
    // turno, e "ocupada desde a construção" segurava reinício/atualização para sempre.
    expect(readFirst().busy).toBe(false)
  })

  it('also constructs when the restart runtime is absent', () => {
    expect(session('without-runtime').restartActivity().busy).toBe(false)
  })

  it('a message handed to the SDK before its init makes the session busy; init clears it', () => {
    const s = session('drained') as unknown as {
      pushInput: (m: unknown) => void
      handleMessage: (m: unknown) => void
      restartActivity: () => RestartActivity
    }
    expect(s.restartActivity().busy).toBe(false)
    s.pushInput({ type: 'user', message: { role: 'user', content: 'oi' } })
    expect(s.restartActivity().busy).toBe(true)
    s.handleMessage({ type: 'system', subtype: 'init', session_id: 's1', model: 'm', cwd: '/test', tools: [] })
    expect(s.restartActivity().busy).toBe(false)
  })
})
