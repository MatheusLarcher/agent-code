import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PersistenceRepository } from './persistence/types'

const sdk = vi.hoisted(() => ({
  importSessionToStore: vi.fn(async () => undefined),
  getSessionInfo: vi.fn(async (): Promise<unknown> => ({ sessionId: 's' })),
  getSessionMessages: vi.fn(async () => [])
}))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)

const { prepareSessionResume } = await import('./sessionResume')

function fakeRepo(entries: unknown[] | null, ready = false) {
  const markSessionResumeReady = vi.fn(async () => undefined)
  const repo = {
    sessionResumeReady: vi.fn(async () => ready),
    createSessionStore: () => ({ append: vi.fn(), load: vi.fn(async () => entries) }),
    markSessionResumeReady
  } as unknown as PersistenceRepository
  return { repo, markSessionResumeReady }
}

describe('prepareSessionResume', () => {
  beforeEach(() => {
    sdk.getSessionInfo.mockResolvedValue({ sessionId: 's' })
    sdk.getSessionMessages.mockResolvedValue([])
  })

  it('já pronta: "ready" sem ler nada', async () => {
    const { repo } = fakeRepo(null, true)
    sdk.importSessionToStore.mockClear()
    expect(await prepareSessionResume(repo, 'c', '/p', 's')).toBe('ready')
    expect(sdk.importSessionToStore).not.toHaveBeenCalled()
  })

  it('sem transcript (nem disco nem banco): "missing" e NÃO marca a sessão como pronta', async () => {
    for (const entries of [null, []]) {
      const { repo, markSessionResumeReady } = fakeRepo(entries)
      expect(await prepareSessionResume(repo, 'c', '/p', 's')).toBe('missing')
      expect(markSessionResumeReady).not.toHaveBeenCalled()
    }
    sdk.getSessionInfo.mockResolvedValueOnce(undefined)
    const { repo, markSessionResumeReady } = fakeRepo([{ type: 'user' }])
    expect(await prepareSessionResume(repo, 'c', '/p', 's')).toBe('missing')
    expect(markSessionResumeReady).not.toHaveBeenCalled()
  })

  it('transcript íntegro: "ready" e marca com o hash verificado', async () => {
    const { repo, markSessionResumeReady } = fakeRepo([{ type: 'user', uuid: 'u1' }])
    expect(await prepareSessionResume(repo, 'c', '/p', 's')).toBe('ready')
    expect(markSessionResumeReady).toHaveBeenCalledWith('c', 's', true, expect.any(String))
  })

  it('falha de leitura ou de marcação continua lançando (só a ausência vira sessão nova)', async () => {
    const broken = {
      sessionResumeReady: async () => false,
      createSessionStore: () => ({ append: vi.fn(), load: async () => { throw new Error('banco fora') } }),
      markSessionResumeReady: vi.fn()
    } as unknown as PersistenceRepository
    await expect(prepareSessionResume(broken, 'c', '/p', 's')).rejects.toThrow('banco fora')

    sdk.getSessionMessages.mockRejectedValueOnce(new Error('transcript corrompido'))
    const { repo } = fakeRepo([{ type: 'user' }])
    await expect(prepareSessionResume(repo, 'c', '/p', 's')).rejects.toThrow('transcript corrompido')
  })
})
