// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), authenticated: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: boundary.spawn }))
vi.mock('./claudeCli', () => ({ claudeCliPath: () => 'bundled-claude.exe' }))
vi.mock('./auth', () => ({
  isAuthenticated: boundary.authenticated,
  envForConfigDir: (dir?: string) => ({ CLAUDE_CONFIG_DIR: dir })
}))
import { runClaudeLogin } from './login'

let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.useFakeTimers()
  boundary.authenticated.mockReset().mockResolvedValue(true)
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  boundary.spawn.mockReset().mockReturnValue(child)
})
afterEach(() => vi.useRealTimers())

describe('renovar login Claude', () => {
  it('abre OAuth mesmo quando auth status ainda diz loggedIn:true', async () => {
    const open = vi.fn()
    const result = runClaudeLogin(open, () => undefined, 'account-dir')
    await vi.advanceTimersByTimeAsync(0)
    child.stdout.write('Visit https://claude.ai/oauth/authorize?test=1\n')
    child.stdout.write('Login successful\n')
    child.emit('exit', 0)
    expect(await result).toBe(true)
    expect(open).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?test=1')
  })

  it('não encerra OAuth antes da autorização por causa da credencial antiga', async () => {
    const result = runClaudeLogin(() => undefined, () => undefined)
    let finished = false
    void result.then(() => { finished = true })
    await vi.advanceTimersByTimeAsync(5000)
    const premature = finished
    child.emit('exit', 0)
    await result
    expect(premature).toBe(false)
  })

  it('login cancelado falha mesmo com credencial antiga salva', async () => {
    const result = runClaudeLogin(() => undefined, () => undefined)
    await vi.advanceTimersByTimeAsync(0)
    child.emit('exit', 1)
    expect(await result).toBe(false)
  })

  it('timeout falha mesmo se a conta antiga aparece como logada', async () => {
    const result = runClaudeLogin(() => undefined, () => undefined)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(await result).toBe(false)
  })
})
