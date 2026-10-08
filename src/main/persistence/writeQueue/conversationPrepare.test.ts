// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { COMPACTION_AGE_MS } from '../../../shared/conversationCompaction'
import { hashJson, normalizeJson } from '../hashes'
import { splitDeviceFields } from '../conversationScope'
import { prepareConversation } from './conversationPrepare'

const NOW = Date.parse('2026-10-08T12:00:00Z')

function doc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    title: 'Chat',
    cwd: 'C:/proj',
    draft: 'rascunho',
    createdAt: NOW - 1_000,
    updatedAt: NOW,
    messages: [
      { kind: 'user', id: 'u1', text: 'oi', images: ['data:image/png;base64,AAAA'] },
      { kind: 'tool', id: 't1', result: { images: ['grande'], text: 'ok' } }
    ],
    ...extra
  }
}

describe('prepareConversation (o que ia para o banco pelo renderer, agora fora da UI)', () => {
  it('carimba o marcador dos Automáticos e tira `images` em qualquer profundidade', () => {
    const prepared = prepareConversation(doc(), 'shared', NOW)
    const payload = JSON.parse(prepared.payloadJson) as Record<string, unknown>
    expect(payload.effortSplit).toBe(true)
    expect(prepared.payloadJson).not.toContain('images')
    expect(payload.messages).toEqual([
      { kind: 'user', id: 'u1', text: 'oi' },
      { kind: 'tool', id: 't1', result: { text: 'ok' } }
    ])
  })

  it('conversa com mais de 15 dias guarda só o pedido e a resposta final', () => {
    const old = doc({
      createdAt: NOW - COMPACTION_AGE_MS - 1,
      messages: [
        { kind: 'user', id: 'u1', text: 'pergunta' },
        { kind: 'tool', id: 't1', text: 'ruído' },
        { kind: 'assistant-text', id: 'a0', text: 'parcial' },
        { kind: 'assistant-text', id: 'a1', text: 'final', answer: true }
      ]
    })
    const payload = JSON.parse(prepareConversation(old, 'shared', NOW).payloadJson) as { messages: Array<{ id: string }> }
    expect(payload.messages.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('hash do PostgreSQL só da parte compartilhada, igual ao que o repositório calcula; o do dispositivo à parte', () => {
    const prepared = prepareConversation(doc(), 'shared', NOW)
    const { shared } = splitDeviceFields(JSON.parse(prepared.payloadJson) as Record<string, unknown>)
    expect(prepared.contentHash).toBe(hashJson(normalizeJson(shared)))
    expect(JSON.parse(prepared.deviceParam)).toEqual({ cwd: 'C:/proj', draft: 'rascunho' })
    expect(prepared.cwd).toBe('C:/proj')

    const otherPc = prepareConversation(doc({ cwd: 'D:/outra', draft: '' }), 'shared', NOW)
    expect(otherPc.contentHash).toBe(prepared.contentHash)
    expect(otherPc.deviceHash).not.toBe(prepared.deviceHash)
    // O SQLite compara o documento inteiro.
    expect(prepareConversation(doc({ cwd: 'D:/outra' }), 'full', NOW).contentHash).not.toBe(
      prepareConversation(doc(), 'full', NOW).contentHash
    )
  })

  it('a ordem das chaves não muda o hash (a comparação que evita regravar sem mudança)', () => {
    const { messages, ...top } = doc()
    const reordered = Object.fromEntries(Object.entries({ messages, ...top }).reverse())
    expect(prepareConversation(reordered, 'shared', NOW).contentHash).toBe(prepareConversation(doc(), 'shared', NOW).contentHash)
  })

  it('conversa sem id é recusada', () => {
    expect(() => prepareConversation(doc({ id: '' }), 'shared', NOW)).toThrow(/sem ID/)
  })
})
