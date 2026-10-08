import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationChangeDto } from '@shared/ipc'
import {
  forgetConversation,
  forgetDelivered,
  isConversationDirty,
  markConversationsDirty,
  markConversationsLoaded,
  markConversationsUrgent,
  resetConversationSync,
  syncConversations
} from './conversationSync'
import { applyChanges } from './conversationSyncFake'
import type { Conversation, UIMessage } from './types'

function chat(id: string, texts: string[], extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: 'Chat',
    cwd: 'C:/proj',
    model: 'claude-opus-5-5',
    sdkSessionId: null,
    messages: texts.map((text, i) => ({ kind: 'user', id: `${id}-m${i}`, text }) as UIMessage),
    tokens: { context: 0, output: 0, cost: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...extra
  }
}

const sync = vi.fn<(changes: ConversationChangeDto[]) => void>()
const sent = (): ConversationChangeDto[] => sync.mock.calls.flatMap(([changes]) => changes)

beforeEach(() => {
  resetConversationSync()
  sync.mockReset()
  Object.defineProperty(window, 'api', { configurable: true, value: { syncConversations: sync } })
})

describe('syncConversations: a tela entrega só o que mudou', () => {
  it('conversa nova vai inteira; o mesmo objeto de novo não vai', () => {
    const c1 = chat('c1', ['oi'])
    expect(syncConversations([c1])).toEqual({ processed: 1, sent: 1 })
    expect(sent()).toEqual([
      { id: 'c1', top: expect.objectContaining({ id: 'c1', title: 'Chat' }), messagesFrom: 0, messages: c1.messages, messageCount: 1 }
    ])
    expect(sent()[0].top).not.toHaveProperty('messages')
    syncConversations([c1])
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('o que veio do banco não volta para a fila (nem com outra conversa mudando)', () => {
    const loaded = chat('c1', ['do banco'])
    markConversationsLoaded([loaded])
    const nova = chat('c2', ['nova'])
    syncConversations([loaded, nova])
    expect(sent().map((change) => change.id)).toEqual(['c2'])
  })

  it('streaming: só a cauda que mudou, sem os campos de topo', () => {
    const c1 = chat('c1', ['pergunta'])
    syncConversations([c1])
    const tail = { kind: 'assistant-text', id: 'a1', text: 'resp' } as UIMessage
    const next = { ...c1, messages: [...c1.messages, tail] }
    syncConversations([next])
    const grown = { ...next, messages: [...c1.messages, { ...tail, text: 'resposta inteira' } as UIMessage] }
    syncConversations([grown])
    expect(sent().slice(1)).toEqual([
      { id: 'c1', messagesFrom: 1, messages: [tail], messageCount: 2 },
      { id: 'c1', messagesFrom: 1, messages: [grown.messages[1]], messageCount: 2 }
    ])
  })

  it('só um campo de topo: vai o topo, sem mensagens', () => {
    const c1 = chat('c1', ['oi'])
    syncConversations([c1])
    syncConversations([{ ...c1, title: 'Renomeada' }])
    expect(sent()[1]).toEqual({ id: 'c1', top: expect.objectContaining({ title: 'Renomeada' }) })
  })

  it('aplicar as entregas reproduz a tela, inclusive com mensagens removidas e trocadas', () => {
    let screen = chat('c1', ['a', 'b', 'c'])
    let db: Array<Conversation & Record<string, unknown>> = []
    const step = (next: Conversation): void => {
      screen = next
      sync.mockClear()
      syncConversations([screen])
      db = applyChanges(db, sent())
    }
    step(screen)
    step({ ...screen, messages: screen.messages.slice(0, 2) })
    step({ ...screen, messages: [...screen.messages, { kind: 'user', id: 'x', text: 'x' } as UIMessage] })
    step({ ...screen, messages: [screen.messages[0], { kind: 'user', id: 'y', text: 'y' } as UIMessage, ...screen.messages.slice(2)] })
    step({ ...screen, title: 'Fim', effort: 'high' })
    expect(db).toEqual([JSON.parse(JSON.stringify(screen))])
  })

  it('bytes de imagem da bolha nunca vão', () => {
    const withImage = chat('c1', [])
    withImage.messages = [{ kind: 'user', id: 'u', text: 'veja', images: ['data:image/png;base64,AAAA'] } as unknown as UIMessage]
    syncConversations([withImage])
    expect(sent()[0].messages).toEqual([{ kind: 'user', id: 'u', text: 'veja' }])
  })
})

describe('exclusão', () => {
  it('sai da lista depois de ter estado nela: vira exclusão (uma vez)', () => {
    const c1 = chat('c1', ['x'])
    const c2 = chat('c2', ['y'])
    markConversationsLoaded([c1, c2])
    syncConversations([c1, c2])
    expect(sync).not.toHaveBeenCalled()
    syncConversations([c1], { only: new Set() })
    syncConversations([c1])
    expect(sent()).toEqual([{ id: 'c2', deleted: true }])
  })

  it('só carregada (nunca esteve na lista entregue) não vira exclusão', () => {
    const naTela = chat('c1', ['x'])
    markConversationsLoaded([naTela, chat('so-carregada', ['y'])])
    syncConversations([naTela])
    expect(sync).not.toHaveBeenCalled()
  })

  it('apagada noutro PC (o feed tirou da tela) não vira exclusão daqui', () => {
    const c1 = chat('c1', ['x'])
    const c2 = chat('c2', ['y'])
    syncConversations([c1, c2])
    sync.mockClear()
    forgetConversation('c2')
    syncConversations([c1])
    expect(sync).not.toHaveBeenCalled()
  })
})

describe('marcas', () => {
  it('suja até a entrega', () => {
    const c1 = chat('c1', ['x'])
    markConversationsDirty(['c1'])
    expect(isConversationDirty('c1')).toBe(true)
    syncConversations([c1], { only: new Set(['c1']) })
    expect(isConversationDirty('c1')).toBe(false)
  })

  it('urgente: pela opção (envio, fechar) ou pela marca (fim de turno), que vale uma entrega', () => {
    const c1 = chat('c1', ['x'])
    syncConversations([c1], { urgent: true })
    markConversationsUrgent(['c1', null])
    const c1b = { ...c1, title: 'b' }
    syncConversations([c1b])
    syncConversations([{ ...c1b, title: 'c' }])
    expect(sent().map((change) => change.urgent === true)).toEqual([true, true, false])
  })

  it('o main perdeu a base: a próxima entrega leva a conversa inteira', () => {
    const c1 = chat('c1', ['x'])
    syncConversations([c1])
    const c1b = { ...c1, messages: [...c1.messages, { kind: 'user', id: 'n', text: 'n' } as UIMessage] }
    syncConversations([c1b])
    forgetDelivered('c1')
    expect(isConversationDirty('c1')).toBe(true)
    syncConversations([c1b], { only: new Set(['c1']) })
    expect(sent()[2]).toMatchObject({ id: 'c1', messagesFrom: 0, messageCount: 2 })
    expect(sent()[2].top).toBeDefined()
  })
})
