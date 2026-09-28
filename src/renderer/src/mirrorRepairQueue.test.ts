import { describe, expect, it } from 'vitest'
import { queueHeadToDrain, requeueDeferredSend, withoutBubble } from './mirrorRepairQueue'
import type { UIMessage } from './types'

const inflight = {
  msgId: 'u-bolha',
  sdkUuid: 'sdk-1',
  full: 'oi [refs da página]',
  images: [{ mediaType: 'image/png', data: 'AAAA' }],
  files: [],
  fileRefs: []
} as unknown as Parameters<typeof requeueDeferredSend>[2]

const messages = [
  { kind: 'user', id: 'u-antiga', text: 'antes', ts: 1 },
  { kind: 'status', id: 's-1', text: 'Falha ao espelhar...' },
  { kind: 'user', id: 'u-bolha', text: 'oi', images: ['data:image/png;base64,AAAA'], ts: 2 }
] as unknown as UIMessage[]

describe('envio devolvido pelo reparo do espelho', () => {
  it('a mensagem em voo volta como item da fila, com texto, anexos e miniaturas; a bolha sai do chat', () => {
    const plan = requeueDeferredSend('conv', 'sdk-1', inflight, messages, 'q-1')
    expect(plan?.item).toEqual({
      id: 'q-1',
      convId: 'conv',
      full: 'oi [refs da página]',
      text: 'oi',
      images: inflight!.images,
      thumbs: ['data:image/png;base64,AAAA'],
      files: [],
      fileRefs: []
    })
    expect(withoutBubble(messages, plan!.bubbleId).map((message) => (message as { id?: string }).id)).toEqual(['u-antiga', 's-1'])
  })

  it('mensagem de tarefa MCP volta à fila com o id da tarefa (o main a continua por ele)', () => {
    const plan = requeueDeferredSend('conv', 'sdk-1', { ...inflight!, mcpTaskId: 't-1' }, messages, 'q-1')
    expect(plan?.item.mcpTaskId).toBe('t-1')
    expect(requeueDeferredSend('conv', 'sdk-1', inflight, messages, 'q-1')?.item).not.toHaveProperty('mcpTaskId')
  })

  it('evento de outra mensagem (ou sem mensagem em voo) não mexe em nada', () => {
    expect(requeueDeferredSend('conv', 'sdk-outra', inflight, messages, 'q-1')).toBeNull()
    expect(requeueDeferredSend('conv', 'sdk-1', undefined, messages, 'q-1')).toBeNull()
  })

  it('espelho restaurado: a cabeça da fila da conversa sai, só se a conversa está parada', () => {
    const queue = [
      { id: 'a', convId: 'outra' },
      { id: 'b', convId: 'conv' },
      { id: 'c', convId: 'conv' }
    ]
    expect(queueHeadToDrain(queue, 'conv', false)?.id).toBe('b')
    expect(queueHeadToDrain(queue, 'conv', true)).toBeNull()
    expect(queueHeadToDrain(queue, 'vazia', false)).toBeNull()
  })
})
