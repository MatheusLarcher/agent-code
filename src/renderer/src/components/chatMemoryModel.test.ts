import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../types'
import { chatMemoryEntries, turnMemoryRequests, messagesForMemoryTurn } from './chatMemoryModel'

const read = (path: string, over: Partial<UIMessage> = {}): UIMessage => ({
  kind: 'tool-use', id: path, name: 'Read', input: { file_path: path },
  parentToolUseId: null, result: { isError: false, text: 'conteúdo não deve aparecer' }, turnIds: ['t1'], ...over
} as UIMessage)

describe('memórias do chat por turno', () => {
  it('atribui Read tardio ao dono persistido, nunca ao pedido seguinte', () => {
    const late = read('D:/mem/tardia.md')
    const messages: UIMessage[] = [
      { kind: 'user', id: 'u1', text: 'primeiro' },
      { kind: 'assistant-text', id: 'a1', text: 'fim', final: true, turnIds: ['t1'] },
      { kind: 'user', id: 'u2', text: 'segundo' }, late
    ]
    expect(turnMemoryRequests(messages)).toEqual([{ userId: 'u1', turnIds: ['t1'] }, { userId: 'u2', turnIds: [] }])
    expect(messagesForMemoryTurn(messages, 'u1')).toContain(late)
    expect(messagesForMemoryTurn(messages, 'u2')).not.toContain(late)
  })
  it('resolve snapshot antes de qualquer resposta pela identidade persistida da bolha', () => {
    const messages = [{ kind: 'user', id: 'u1', text: 'pedido', sdkUuid: 't1' }] as UIMessage[]
    expect(turnMemoryRequests(messages)).toEqual([{ userId: 'u1', turnIds: ['t1'] }])
  })
  it('une fornecida e lida sem duplicar e nunca transforma catálogo em leitura', () => {
    const msgs = [read('D:/mem/projeto/regra.md'), read('D:/mem/projeto/regra.md'),
      { ...read('query'), name: 'mcp__memory__memory_list', input: {} } as UIMessage]
    expect(chatMemoryEntries(msgs, ['projeto/regra.md', 'projeto/regra.md'], 'D:/mem')).toEqual([
      { relPath: 'projeto/regra.md', supplied: true, read: true }
    ])
  })
  it('recusa falhas, pendentes, índices e caminhos arbitrários como memórias', () => {
    expect(chatMemoryEntries([
      read('D:/mem/falhou.md', { result: { isError: true, text: 'erro' } }),
      read('D:/mem/pendente.md', { result: undefined }), read('D:/mem/MEMORY.md'),
      read('D:/fora/arbitrario.md'), read('D:/mem/cofre.json')
    ], ['../escape.md', 'C:/segredo.md', 'cofre.json', 'MEMORY.md', 'bom.md'], 'D:/mem')).toEqual([
      { relPath: 'bom.md', supplied: true, read: false }
    ])
  })
  it('identifica turnos históricos pelo id persistido sem cruzar mensagens injetadas', () => {
    const messages: UIMessage[] = [
      { kind: 'user', id: 'u1', text: 'primeiro' }, read('D:/mem/a.md'),
      { kind: 'user', id: 'ajuste', text: 'ajuste', injected: true }, read('D:/mem/b.md'),
      { kind: 'user', id: 'u2', text: 'segundo' }, { ...read('D:/mem/c.md'), turnIds: ['t2'] } as UIMessage
    ]
    expect(turnMemoryRequests(messages)).toEqual([
      { userId: 'u1', turnIds: ['t1'] }, { userId: 'u2', turnIds: ['t2'] }
    ])
  })
})
