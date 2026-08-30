import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { forkSessionBundle, type SessionBundle } from './postgresSessionTransfer'

describe('forkSessionBundle', () => {
  it('uses the public SDK fork API to preserve a divergent transcript under a resumable UUID', async () => {
    const sessionId = randomUUID()
    const userId = randomUUID()
    const assistantId = randomUUID()
    const bundle: SessionBundle = {
      conversationId: randomUUID(),
      conversationPayload: { id: 'conversation', title: 'Source' },
      sessionId,
      mtime: Date.now(),
      paths: [{
        entries: [
          {
            type: 'user',
            uuid: userId,
            parentUuid: null,
            sessionId,
            message: { role: 'user', content: 'hello' }
          },
          {
            type: 'assistant',
            uuid: assistantId,
            parentUuid: userId,
            sessionId,
            message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }
          }
        ]
      }]
    }

    const forked = await forkSessionBundle(bundle)

    expect(forked.sessionId).not.toBe(sessionId)
    expect(forked.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(forked.paths).toHaveLength(1)
    expect(forked.paths[0].entries).toHaveLength(3)
    expect(forked.paths[0].entries.some((entry) => entry.type === 'custom-title')).toBe(true)
    expect(forked.paths[0].entries.every((entry) => entry.sessionId === forked.sessionId)).toBe(true)
  })
})
