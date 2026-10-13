/**
 * O que a linha do subagente mostra (chatSubagentModel.ts): estado, quem é, a
 * tarefa (com recuo para o prompt) e a máscara de segredos nas ações e no relatório.
 */
import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../types'
import type { ChatSubagent } from './chatSteps'
import { safeToolMessage, subagentName, subagentReport, subagentState, subagentTask } from './chatSubagentModel'

const call = (input: unknown, result?: { isError: boolean; text: string }, extra: Record<string, unknown> = {}): UIMessage =>
  ({ kind: 'tool-use', id: 't1', name: 'Task', input, parentToolUseId: null, ...(result ? { result } : {}), ...extra }) as UIMessage
const sub = (c: UIMessage, running = false, tools: UIMessage[] = []): ChatSubagent<UIMessage> => ({ call: c, tools, running })
const ok = { isError: false, text: 'feito' }

describe('chatSubagentModel', () => {
  it('estado: trabalhando, concluído, erro e interrompido (sem resultado e parado)', () => {
    expect(subagentState(sub(call({}), true))).toBe('trabalhando')
    expect(subagentState(sub(call({}, ok)))).toBe('concluido')
    expect(subagentState(sub(call({}, { isError: true, text: 'falhou' })))).toBe('erro')
    expect(subagentState(sub(call({})))).toBe('interrompido')
  })

  it('nome: subagentType, senão input.subagent_type, senão "Subagente"', () => {
    expect(subagentName(sub(call({ subagent_type: 'Explore' }, ok, { subagentType: 'executor' })))).toBe('executor')
    expect(subagentName(sub(call({ subagent_type: 'Explore' })))).toBe('Explore')
    expect(subagentName(sub(call({})))).toBe('Subagente')
  })

  it('tarefa: a descrição; sem ela a 1ª linha do prompt; cortada e mascarada', () => {
    expect(subagentTask(sub(call({ description: 'achar o reducer', prompt: 'x' })))).toBe('achar o reducer')
    expect(subagentTask(sub(call({ prompt: 'Leia o App.tsx\ne depois...' })))).toBe('Leia o App.tsx')
    expect(subagentTask(sub(call({}, ok, { taskDescription: 'usar ⟦senha:db⟧' })))).toBe('usar [senha: db]')
    const long = subagentTask(sub(call({ description: 'a'.repeat(300) })))
    expect(long).toHaveLength(160)
    expect(long.endsWith('…')).toBe(true)
    expect(subagentTask(sub(call({})))).toBe('')
  })

  it('não expõe segredos: valor do cofre some e placeholders viram só o nome', () => {
    const secret = { kind: 'tool-use', id: 's', name: 'mcp__memory__memory_secret_get', input: {}, parentToolUseId: 't1', result: { isError: false, text: 'sk-live-123' } } as UIMessage
    expect((safeToolMessage(secret) as { result: { text: string } }).result.text).toBe('[valor do cofre oculto]')
    const read = { kind: 'tool-use', id: 'r', name: 'Read', input: {}, parentToolUseId: 't1', result: { isError: false, text: 'token ⟦senha:api⟧ ok' } } as UIMessage
    expect((safeToolMessage(read) as { result: { text: string } }).result.text).toBe('token [senha: api] ok')
    // Nada a mascarar: o mesmo objeto (não redesenha à toa).
    const plain = { ...read, result: { isError: false, text: 'ok' } } as UIMessage
    expect(safeToolMessage(plain)).toBe(plain)
    expect(subagentReport(sub(call({}, { isError: false, text: ' usei ⟦senha:db⟧ ' })))).toBe('usei [senha: db]')
    expect(subagentReport(sub(call({})))).toBeUndefined()
  })
})
