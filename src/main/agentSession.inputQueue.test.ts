// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { AgentSession } from './agentSession'
import type { BrowserController } from './browserController'

describe('AgentSession persisted input FIFO', () => {
  it('keeps B pending while A is current and preserves identity on retry', async () => {
    const rows = [
      { id: 11, message: { message: { content: 'A' } } },
      { id: 12, message: { message: { content: 'B' } } }
    ]
    const repo = {
      claimNextAgentInput: vi.fn(async () => rows.shift() ?? null),
      requeueAgentInput: vi.fn(async () => undefined),
      completeAgentInput: vi.fn(async () => undefined)
    }
    const browser = {} as BrowserController
    const session = new AgentSession(
      { convId: 'fifo', cwd: '/tmp' }, browser, vi.fn(), vi.fn(), vi.fn(), undefined, undefined, undefined, undefined, undefined, repo as never
    )
    const input = (session as unknown as { input: { push: (value: unknown) => void } }).input
    const pushed: unknown[] = []
    input.push = (value) => pushed.push(value)
    const drain = (session as unknown as { drainPersistedInputs(): Promise<void> }).drainPersistedInputs.bind(session)

    await Promise.all([drain(), drain()])
    expect(repo.claimNextAgentInput).toHaveBeenCalledTimes(1)
    expect(pushed).toHaveLength(1)
    expect((session as unknown as { currentInputId: number }).currentInputId).toBe(11)

    ;(session as unknown as { currentInputId: number | null }).currentInputId = null
    await drain()
    expect(repo.claimNextAgentInput).toHaveBeenCalledTimes(2)
    expect(pushed).toHaveLength(2)
    expect((session as unknown as { currentInputId: number }).currentInputId).toBe(12)
  })

  it('botão "agora": com turno em andamento vai direto ao stream com priority next, fora da fila durável', () => {
    const repo = {
      claimNextAgentInput: vi.fn(async () => null),
      requeueAgentInput: vi.fn(async () => undefined),
      completeAgentInput: vi.fn(async () => undefined),
      enqueueAgentInput: vi.fn(async () => undefined)
    }
    const session = new AgentSession(
      { convId: 'agora', cwd: '/tmp' }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn(), undefined, undefined, undefined, undefined, undefined, repo as never
    )
    const internals = session as unknown as { input: { push: (value: unknown) => void }; turnActive: boolean; q: unknown }
    const pushed: Array<{ priority?: string; message: { content: unknown } }> = []
    internals.input.push = (value) => pushed.push(value as never)

    // Sem turno: não injeta (a mensagem segue pela fila normal).
    expect(session.injectNow('usa a pasta X')).toBe(false)
    expect(pushed).toHaveLength(0)

    internals.turnActive = true
    internals.q = {}
    expect(session.injectNow('usa a pasta X', undefined, 'u-1')).toBe(true)
    expect(pushed).toHaveLength(1)
    expect(pushed[0].priority).toBe('next')
    expect(String(pushed[0].message.content)).toContain('NÃO cancela')
    expect(String(pushed[0].message.content)).toContain('usa a pasta X')
    expect(repo.enqueueAgentInput).not.toHaveBeenCalled()
  })
})
