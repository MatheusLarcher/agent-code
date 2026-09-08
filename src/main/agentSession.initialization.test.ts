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
    expect(readFirst().busy).toBe(true)
  })

  it('also constructs when the restart runtime is absent', () => {
    expect(session('without-runtime').restartActivity().busy).toBe(true)
  })
})
