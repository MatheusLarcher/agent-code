// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { registerContextIpc } from './ipc'
import { Channels } from '../../shared/ipc'
import { ContextCapture, detailOf } from './capture'
import type { ContextTurnWrite } from '../persistence/types'
import type { ContextHistoryRepository } from '../persistence/types'

describe('context PC IPC', () => {
  function setup() {
    const handlers = new Map<string, (...args: any[]) => any>()
    const repository = {
      listContextTurns: vi.fn(async () => [{ turnId: 'u' }]),
      readContextTurn: vi.fn(async () => ({ convId: 'c', turnId: 'u', blocks: [], usage: { detail: 'summary', totalTokens: 5 }, secrets: [] }))
    } as unknown as ContextHistoryRepository
    const reveal = vi.fn(async (name: string) => name === 'vault' ? 'CURRENT' : null)
    registerContextIpc({ handle: (name, handler) => { handlers.set(name, handler) }, repository: () => repository, reveal })
    return { call: (name: string, ...args: unknown[]) => handlers.get(name)!(null, ...args), repository, reveal }
  }
  it.each(['X', 'YZ', 'UVW', 'senha-real'])('IPC vivo e persistido não vazam valor conhecido %s', async (value) => {
    const { call, repository } = setup()
    const writes: ContextTurnWrite[] = []
    repository.saveContextTurn = async (w) => { writes.push(w) }
    const c = new ContextCapture({ convId: 'ipc-mask', pc: 'PC', model: 'model', provider: 'claude' }, repository, undefined, () => null)
    c.configure(`append ${value}`, [{ name: 'vault', value }], { executor: { prompt: `regra ${value}` } })
    c.sent('u', `pedido ${value}`, `pedido ${value}`, { stamp: 'stamp', memory: '', skills: '', projects: '' }); c.activate('u')
    c.hook({ docs: `docs ${value}`, memory: `memória ${value}` }, 'hook-start')
    c.subagent('task-id', { subagent_type: 'executor', prompt: `sub ${value}` })
    expect(JSON.stringify(await call(Channels.contextTurnsRead, 'ipc-mask', 'u'))).not.toContain(value)
    expect(JSON.stringify(await call(Channels.contextTurnsRead, 'ipc-mask', 'u', 'task-id'))).not.toContain(value)
    await c.finish(['u']); await c.flush(); c.dispose()
    vi.mocked(repository.readContextTurn).mockResolvedValue(detailOf(writes.at(-1)!))
    expect(JSON.stringify(await call(Channels.contextTurnsRead, 'ipc-mask', 'u'))).not.toContain(value)
    expect((await call(Channels.contextTurnsRead, 'ipc-mask', 'u', 'task-id')).blocks).toHaveLength(2)
    expect(JSON.stringify(writes)).not.toContain(value)
  })
  it('lista só 10, lê turno e devolve último resumo sem sessão', async () => {
    const { call, repository } = setup()
    expect(await call(Channels.contextTurnsList, 'c')).toEqual([{ turnId: 'u' }])
    expect(repository.listContextTurns).toHaveBeenCalledWith('c', 10)
    expect(await call(Channels.contextTurnsRead, 'c', 'u')).toMatchObject({ turnId: 'u' })
    expect(await call(Channels.contextTurnsCountExact, 'c')).toMatchObject({ ok: false, usage: { totalTokens: 5 }, reason: expect.any(String) })
    expect(await call(Channels.secretsReveal, 'vault')).toBe('CURRENT')
  })
  it('valida strings sem lançar nem consultar backend/cofre', async () => {
    const { call, repository, reveal } = setup()
    for (const bad of ['', ' ', 1, null, undefined]) {
      expect(await call(Channels.contextTurnsList, bad)).toEqual([])
      expect(await call(Channels.contextTurnsRead, 'c', bad)).toBeNull()
      if (bad !== undefined) expect(await call(Channels.contextTurnsRead, 'c', 'u', bad)).toBeNull()
      expect(await call(Channels.contextTurnsCountExact, bad)).toMatchObject({ ok: false })
      expect(await call(Channels.secretsReveal, bad)).toBeNull()
    }
    expect(repository.listContextTurns).not.toHaveBeenCalled()
    expect(repository.readContextTurn).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
  })
  it('backend/cofre offline degradam sem expor exceção', async () => {
    const { call, repository, reveal } = setup()
    vi.mocked(repository.listContextTurns).mockRejectedValue(new Error('offline'))
    vi.mocked(repository.readContextTurn).mockRejectedValue(new Error('offline'))
    reveal.mockRejectedValue(new Error('offline'))
    expect(await call(Channels.contextTurnsRead, 'c', 'u')).toBeNull()
    expect(await call(Channels.contextTurnsList, 'c')).toEqual([])
    expect(await call(Channels.contextTurnsCountExact, 'c')).toMatchObject({ ok: false, usage: null })
    expect(await call(Channels.secretsReveal, 'vault')).toBeNull()
  })
  it('ponte LAN não conhece canais de histórico ou reveal', () => {
    const remote = readFileSync(new URL('../remote/remoteServer.ts', import.meta.url), 'utf8')
    expect(remote).not.toMatch(/contextTurns|context-turn|secrets:reveal|revealSecret|readSecretForReveal/u)
  })
})
