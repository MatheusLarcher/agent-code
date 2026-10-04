import { describe, expect, it } from 'vitest'
import { conv, feed } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { memoryUse, scanMemorySequences } from './memoryTrips'

const MEM = 'D:\\dados\\memories'
const tool = (id: string, name: string, input: unknown = {}): UIMessage => ({ kind: 'tool-use', id, name, input, parentToolUseId: null, result: { isError: false, text: 'ok' } }) as UIMessage
const principal = { key: 'conv:a', convId: 'a', role: 'principal' as const }

describe('consulta à memória (memoryTrips)', () => {
  it('memoryUse: mcp__memory__* (propose grava), Read/Grep/Glob dentro da pasta de memórias; o resto não', () => {
    expect(memoryUse('mcp__memory__memory_list', {}, null)).toBe('read')
    expect(memoryUse('mcp__memory__memory_propose', {}, null)).toBe('write')
    expect(memoryUse('Read', { file_path: 'D:\\dados\\memories\\2D\\x.md' }, MEM)).toBe('read')
    expect(memoryUse('Grep', { pattern: 'x', path: 'd:/dados/memories' }, MEM)).toBe('read')
    expect(memoryUse('Glob', { pattern: 'D:\\dados\\memories\\**\\*.md' }, MEM)).toBe('read')
    expect(memoryUse('Read', { file_path: 'D:\\dados\\memories-velhas\\x.md' }, MEM)).toBeNull()
    expect(memoryUse('Read', { file_path: 'C:\\proj\\a.ts' }, MEM)).toBeNull()
    expect(memoryUse('Read', { file_path: 'D:\\dados\\memories\\x.md' }, null)).toBeNull()
    expect(memoryUse('Edit', { file_path: 'D:\\dados\\memories\\x.md' }, MEM)).toBeNull()
  })

  it('na sequência: a última ferramenta do turno em curso é consulta (várias seguidas contam juntas; gravar marca a ida); acaba na próxima ferramenta', () => {
    const at = (msgs: UIMessage[], busy = true) => scanMemorySequences(feed({ conversations: [conv('a', { messages: msgs })], busyIds: new Set(busy ? ['a'] : []) }), [principal], MEM)
    const user: UIMessage = { kind: 'user', id: 'u', text: 'oi' } as UIMessage
    expect(at([user, tool('t1', 'Edit'), tool('t2', 'mcp__memory__memory_list')]).get('conv:a')).toBe('read')
    expect(at([user, tool('t1', 'mcp__memory__memory_propose'), tool('t2', 'Read', { file_path: `${MEM}\\a.md` })]).get('conv:a')).toBe('write')
    expect(at([user, tool('t1', 'mcp__memory__memory_list'), tool('t2', 'Edit')]).has('conv:a')).toBe(false)
    // Turno acabado (não ocupado) ou consulta antes da mensagem do usuário: nada.
    expect(at([user, tool('t1', 'mcp__memory__memory_list')], false).has('conv:a')).toBe(false)
    expect(at([tool('t1', 'mcp__memory__memory_list'), user]).has('conv:a')).toBe(false)
  })

  it('o subagente pelos passos da trilha rodando', () => {
    const step = (id: string, name: string) => ({ id, name, input: {}, startedAt: 0, result: 'ok' })
    const f = feed({ conversations: [conv('a')], tracks: { a: { T: { id: 'T', label: '', status: 'running', startedAt: 0, stepCount: 2, steps: [step('s1', 'Read'), step('s2', 'mcp__memory__memory_status')] } } } })
    expect(scanMemorySequences(f, [{ key: 'track:T', convId: 'a', role: 'subagente', trackId: 'T' }], MEM).get('track:T')).toBe('read')
  })
})
