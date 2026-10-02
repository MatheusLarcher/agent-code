// Conteúdo da tela do monitor (a ferramenta atual e o formato por tipo) — o
// que o Escritório 3D mostra na textura do monitor e no cartão do foco.
import { describe, expect, it } from 'vitest'
import type { AgentTrack } from '../../agentTracks'
import { conv, feed } from '../../office/adapter/testFeed'
import type { UIMessage } from '../../types'
import { currentTool, screenModel, type CurrentTool } from './screenContent'

function use(id: string, name: string, input: unknown, result?: string): UIMessage {
  return {
    kind: 'tool-use',
    id,
    name,
    input,
    parentToolUseId: null,
    ...(result !== undefined ? { result: { isError: false, text: result } } : {})
  } as UIMessage
}

function tool(name: string, input: Record<string, unknown>, result?: string): CurrentTool {
  return { id: 't1', name, input, result, open: result === undefined }
}

describe('screenContent', () => {
  it('principal: pega o tool-use mais recente sem result; sem aberto, o último', () => {
    const f = feed({
      conversations: [conv('a', { messages: [use('1', 'Read', { file_path: 'x.ts' }), use('2', 'Bash', { command: 'ls' }, 'ok')] })]
    })
    expect(currentTool(f, { key: 'k', convId: 'a', role: 'principal' })?.id).toBe('1')
    const g = feed({ conversations: [conv('a', { messages: [use('1', 'Read', {}, 'r'), use('2', 'Bash', {}, 'ok')] })] })
    expect(currentTool(g, { key: 'k', convId: 'a', role: 'principal' })?.id).toBe('2')
  })

  it('subagente: vem da trilha tracks[cid]', () => {
    const track = {
      id: 'T',
      label: 'x',
      status: 'running',
      startedAt: 0,
      stepCount: 2,
      steps: [
        { id: 's1', name: 'Grep', input: { pattern: 'a' }, startedAt: 0, endedAt: 1, result: 'f.ts' },
        { id: 's2', name: 'Write', input: { file_path: 'b.ts', content: 'oi' }, startedAt: 2 }
      ]
    } as AgentTrack
    const f = feed({ conversations: [conv('a')], tracks: { a: { T: track } } })
    const t = currentTool(f, { key: 'k', convId: 'a', role: 'executor', trackId: 'T' })
    expect(t?.id).toBe('s2')
  })

  it('modelo por ferramenta', () => {
    expect(screenModel(tool('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }))).toMatchObject({
      kind: 'diff',
      path: 'a.ts',
      hunks: [{ old: 'x', new: 'y' }]
    })
    expect(screenModel(tool('MultiEdit', { file_path: 'a.ts', edits: [{ old_string: '1', new_string: '2' }, { old_string: '3', new_string: '4' }] }))).toMatchObject({ kind: 'diff', hunks: [{}, {}] })
    expect(screenModel(tool('Write', { file_path: 'b.ts', content: 'c' }))).toMatchObject({ kind: 'write', text: 'c' })
    const out = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n')
    const bash = screenModel(tool('Bash', { command: 'npm test' }, out))
    expect(bash).toMatchObject({ kind: 'bash', command: 'npm test' })
    expect(bash.kind === 'bash' && bash.output.split('\n')).toHaveLength(40)
    expect(screenModel(tool('Glob', { pattern: '*.ts' }, 'a.ts\nb.ts\n'))).toMatchObject({ kind: 'grep', lines: ['a.ts', 'b.ts'] })
    expect(screenModel(null)).toEqual({ kind: 'empty' })
  })
})
