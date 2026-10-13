/**
 * O redutor da lista de mensagens (reduceMessages.ts): a ferramenta de
 * subagente é GRAVADA já sem segredo e aparada; a principal fica intacta.
 */
import { describe, expect, it } from 'vitest'
import type { ChatEvent } from '@shared/ipc'
import { safeToolMessage } from './components/chatSubagentModel'
import { reduceMessages, SUBAGENT_RESULT_MAX } from './reduceMessages'
import type { UIMessage } from './types'

const use = (id: string, name: string, parent: string | null): ChatEvent =>
  ({ kind: 'tool-use', id, name, input: {}, parentToolUseId: parent }) as ChatEvent
const result = (toolUseId: string, text: string, parent: string | null): ChatEvent =>
  ({ kind: 'tool-result', toolUseId, isError: false, text, parentToolUseId: parent }) as ChatEvent
const run = (events: ChatEvent[]): UIMessage[] => events.reduce<UIMessage[]>(reduceMessages, [])
const textOf = (list: UIMessage[], id: string): string | undefined =>
  (list.find((m) => m.kind === 'tool-use' && m.id === id) as { result?: { text: string } } | undefined)?.result?.text

describe('reduceMessages — o resultado do subagente gravado sem segredo', () => {
  it('memory_secret_get do subagente: o valor do cofre nunca chega à conversa gravada', () => {
    const list = run([use('task', 'Task', null), use('s1', 'mcp__memory__memory_secret_get', 'task'), result('s1', 'hunter2-valor-real', 'task')])
    expect(textOf(list, 's1')).toBe('[valor do cofre oculto]')
    expect(JSON.stringify(list)).not.toContain('hunter2')
  })

  it('placeholder do cofre no resultado do subagente vira só o nome; a máscara do desenho continua valendo', () => {
    const list = run([use('task', 'Task', null), use('s1', 'Read', 'task'), result('s1', 'token ⟦senha:api⟧ ok', 'task')])
    expect(textOf(list, 's1')).toBe('token [senha: api] ok')
    const stored = list.find((m) => m.kind === 'tool-use' && m.id === 's1')!
    expect(safeToolMessage(stored)).toBe(stored) // já gravado mascarado: o desenho não tem o que trocar
  })

  it('resultado longo do subagente: mascarado e aparado no teto', () => {
    const long = `⟦senha:db⟧ ${'x'.repeat(SUBAGENT_RESULT_MAX * 2)}`
    const text = textOf(run([use('task', 'Task', null), use('s1', 'Read', 'task'), result('s1', long, 'task')]), 's1')!
    expect(text.startsWith('[senha: db] ')).toBe(true)
    expect(text).toHaveLength(SUBAGENT_RESULT_MAX + 2)
  })

  it('a trilha principal fica como era: resultado inteiro, sem máscara nem corte', () => {
    const long = `⟦senha:db⟧ ${'x'.repeat(SUBAGENT_RESULT_MAX * 2)}`
    expect(textOf(run([use('t1', 'Read', null), result('t1', long, null)]), 't1')).toBe(long)
  })

  it('TodoWrite/TaskCreate não entram, e o resultado órfão some', () => {
    expect(run([use('t1', 'TodoWrite', null), use('t2', 'TaskCreate', null), result('t1', 'ok', null)])).toEqual([])
  })
})
