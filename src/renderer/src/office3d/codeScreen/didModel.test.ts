import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../../types'
import { didOfTurn, segmentForTurn } from './didModel'
import { distinctModels, shortModelName, modelProvider } from './modelTags'

let seq = 0
const user = (): UIMessage => ({ kind: 'user', id: `u${seq++}`, text: 'pedido' })
const tool = (name: string, input: unknown, opts: { turn?: string; model?: string } = {}): UIMessage => ({
  kind: 'tool-use', id: `t${seq++}`, name, input, parentToolUseId: null, result: { isError: false, text: 'ok' },
  ...(opts.turn ? { turnIds: [opts.turn] } : {}), ...(opts.model ? { model: opts.model } : {})
}) as UIMessage
const P = 'C:\\proj\\'

describe('segmentForTurn', () => {
  it('acha o trecho do turno pelo turnIds e inclui a continuação sem turnIds próprio', () => {
    const msgs = [user(), tool('Read', { file_path: P + 'a.ts' }, { turn: 'T1' }), tool('Edit', { file_path: P + 'a.ts', old_string: 'a', new_string: 'b' }, { turn: 'R1' }), user(), tool('Bash', { command: 'ls' }, { turn: 'T2' })]
    expect(segmentForTurn(msgs, 'T1')!.map((m) => m.kind)).toEqual(['user', 'tool-use', 'tool-use'])
    expect(segmentForTurn(msgs, 'T2')!.length).toBe(2)
    expect(segmentForTurn(msgs, 'outro')).toBeNull()
    expect(segmentForTurn(msgs, null)!.length).toBe(2)
  })
})

describe('didOfTurn', () => {
  it('arquivos com +/− e os modelos de cada um; memórias enviada/lida/gravada', () => {
    const msgs = [
      user(),
      tool('Edit', { file_path: P + 'a.ts', old_string: 'x\ny', new_string: 'z' }, { model: 'claude-opus-5-5' }),
      tool('Edit', { file_path: P + 'a.ts', old_string: 'q', new_string: 'r\ns\nt' }, { model: 'gpt-6.1-sol' }),
      tool('Read', { file_path: 'D:\\mem\\b.md' }, { model: 'gpt-6.1-sol' }),
      tool('mcp__memory__memory_propose', { op: 'create', rel_path: 'c.md' }, { model: 'gpt-6.1-sol' })
    ]
    const did = didOfTurn(msgs, { memoriesDir: 'D:\\mem', memoriesSent: ['a.md'] })
    expect(did.files.map((f) => [f.name, f.added, f.removed, f.models])).toEqual([['a.ts', 4, 3, ['claude-opus-5-5', 'gpt-6.1-sol']]])
    expect(did.memories.map((m) => [m.tag, m.relPath, 'model' in m ? m.model : undefined])).toEqual([
      ['sent', 'a.md', undefined], ['read', 'b.md', 'gpt-6.1-sol'], ['saved', 'c.md', 'gpt-6.1-sol']
    ])
    expect(did.models).toEqual(['claude-opus-5-5', 'gpt-6.1-sol'])
  })
})

describe('modelTags', () => {
  it('etiqueta curta e provedor; id desconhecido como veio; vazio e Automático fora', () => {
    expect([shortModelName('claude-opus-5-5'), shortModelName('gpt-6.1-sol'), shortModelName('claude-haiku-4-5')]).toEqual(['Opus', 'Sol', 'claude-haiku-4-5'])
    expect([modelProvider('claude-opus-5-5'), modelProvider('gpt-6-luna'), modelProvider('kimi-k3:cloud'), modelProvider('x')]).toEqual(['claude', 'gpt', 'ollama', 'other'])
    expect(distinctModels(['a', '', 'auto', 'a', undefined, 'b'])).toEqual(['a', 'b'])
  })
})
