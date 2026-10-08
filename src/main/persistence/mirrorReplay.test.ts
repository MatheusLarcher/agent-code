import { describe, expect, it, vi } from 'vitest'
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { loadOnce, verifyMirroredSession } from './mirrorReplay'

const SESSION = '0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b'

function transcript(): SessionStoreEntry[] {
  return [
    {
      type: 'user',
      uuid: '11111111-1111-4111-8111-111111111111',
      parentUuid: null,
      sessionId: SESSION,
      timestamp: '2026-10-07T12:00:00.000Z',
      message: { role: 'user', content: 'oi' }
    },
    {
      type: 'assistant',
      uuid: '22222222-2222-4222-8222-222222222222',
      parentUuid: '11111111-1111-4111-8111-111111111111',
      sessionId: SESSION,
      timestamp: '2026-10-07T12:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'olá' }] }
    }
  ] as SessionStoreEntry[]
}

function countingStore(): SessionStore & { loads: SessionKey[] } {
  const loads: SessionKey[] = []
  return {
    loads,
    append: async () => undefined,
    load: async (key) => {
      loads.push(key)
      return key.sessionId === SESSION && !key.subpath ? transcript() : null
    }
  }
}

describe('loadOnce', () => {
  it('lê cada sessão/subpath uma vez só, qualquer que seja o projectKey', async () => {
    const store = countingStore()
    const reader = loadOnce(store)
    const [a, b] = await Promise.all([
      reader.load({ projectKey: 'conv-1', sessionId: SESSION }),
      reader.load({ projectKey: 'C--GitHub-mapa', sessionId: SESSION })
    ])
    await reader.load({ projectKey: 'conv-1', sessionId: SESSION, subpath: 'subagents/agent-a' })
    expect(a).toBe(b)
    expect(store.loads).toHaveLength(2)
  })
})

describe('verifyMirroredSession', () => {
  // Uma sessão com screenshots passa de 100 MB: getSessionInfo, a conferência e
  // getSessionMessages liam a sessão inteira três vezes do banco.
  it('baixa a sessão uma única vez e marca a retomada como pronta', async () => {
    const store = countingStore()
    const repository = { markSessionResumeReady: vi.fn(async () => undefined) }
    await verifyMirroredSession(repository, store, 'conv-1', SESSION, 'C:\\GitHub\\mapa')
    expect(store.loads).toHaveLength(1)
    expect(repository.markSessionResumeReady).toHaveBeenCalledWith('conv-1', SESSION, true, expect.stringMatching(/^[0-9a-f]{64}$/))
  })

  it('não marca pronta quando o store não tem a sessão', async () => {
    const store: SessionStore = { append: async () => undefined, load: async () => null }
    const repository = { markSessionResumeReady: vi.fn(async () => undefined) }
    await expect(verifyMirroredSession(repository, store, 'conv-1', SESSION, 'C:\\GitHub\\mapa')).rejects.toMatchObject({
      code: 'SESSION_HANDOFF_INCOMPLETE'
    })
    expect(repository.markSessionResumeReady).not.toHaveBeenCalled()
  })
})
