import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgentTrack } from '../../agentTracks'
import { conv, feed } from '../../office/adapter/testFeed'
import { liveInput, type ToolInputDelta } from '../../office/liveInput'
import type { UIMessage } from '../../types'
import { CodeScreen } from './CodeScreen'
import { currentTool, screenModel, type CurrentTool } from './screenContent'
import { revealFraction, revealText, typingDuration } from './typing'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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
    expect(currentTool(f, { key: 'k', convId: 'a', role: 'principal' } as never)?.id).toBe('1')
    const g = feed({ conversations: [conv('a', { messages: [use('1', 'Read', {}, 'r'), use('2', 'Bash', {}, 'ok')] })] })
    expect(currentTool(g, { key: 'k', convId: 'a', role: 'principal' } as never)?.id).toBe('2')
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
    const t = currentTool(f, { key: 'k', convId: 'a', role: 'executor', trackId: 'T' } as never)
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

describe('typing', () => {
  it('duração entre 1 e 2 s; fração e corte', () => {
    expect(typingDuration(0)).toBe(1000)
    expect(typingDuration(100_000)).toBe(2000)
    expect(revealFraction(0, 500, 1000)).toBe(0.5)
    expect(revealFraction(0, 5000, 1000)).toBe(1)
    expect(revealText('abcd', 0.5)).toBe('ab')
  })
})

function feedWith(messages: UIMessage[]) {
  return feed({ conversations: [conv('a', { messages })] })
}
const MAIN = { key: 'conv:a', convId: 'a', role: 'principal' } as never

describe('CodeScreen', () => {
  it('diff: old em vermelho, new em verde; clique no caminho abre o arquivo', () => {
    const onOpenFile = vi.fn()
    const f = feedWith([use('1', 'Edit', { file_path: 'C:\\p\\a.ts', old_string: 'const a = 1', new_string: 'const a = 2' })])
    const { container } = render(<CodeScreen feed={f} info={MAIN} onOpenFile={onOpenFile} now={() => 1e9} />)
    expect(container.querySelector('.office-screen-old')?.textContent).toBe('const a = 1')
    expect(container.querySelector('.office-screen-new')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'a.ts' }))
    expect(onOpenFile).toHaveBeenCalledWith('C:\\p\\a.ts')
  })

  it('Write, Bash e Grep renderizam seu formato', () => {
    const cases: Array<[UIMessage, string, string]> = [
      [use('1', 'Write', { file_path: 'b.md', content: 'olá' }), 'write', 'b.md'],
      [use('2', 'Bash', { command: 'npm test' }, 'passou'), 'bash', '$ npm test'],
      [use('3', 'Grep', { pattern: 'foo' }, 'x.ts:1:foo'), 'grep', 'foo']
    ]
    for (const [m, kind, text] of cases) {
      const { getByTestId, unmount } = render(<CodeScreen feed={feedWith([m])} info={MAIN} onOpenFile={vi.fn()} />)
      expect(getByTestId('office-screen').dataset.kind).toBe(kind)
      expect(getByTestId('office-screen').textContent).toContain(text)
      unmount()
    }
  })

  it('digitação revela o conteúdo real em 1–2 s com relógio injetável', () => {
    vi.useFakeTimers()
    let t = 0
    const content = 'x'.repeat(400)
    const f = feedWith([use('1', 'Write', { file_path: 'c.txt', content })])
    const { container } = render(<CodeScreen feed={f} info={MAIN} onOpenFile={vi.fn()} now={() => t} />)
    const code = (): string => container.querySelector('.office-screen-code')?.textContent ?? ''
    expect(code().length).toBe(0)
    t = 600 // duração = 1200 ms
    act(() => void vi.advanceTimersByTime(50))
    expect(code().length).toBe(200)
    t = 1200
    act(() => void vi.advanceTimersByTime(50))
    expect(code()).toBe(content)
  })

  it('principal ao vivo: assina enquanto montada; desmontada, nada fica', () => {
    const f = feedWith([])
    const ev: ToolInputDelta = { kind: 'tool-input-delta', toolUseId: 'u', name: 'Write', filePath: 'd.ts', newText: 'linha nova', totalLines: 1, done: false }
    const { getByTestId, unmount } = render(<CodeScreen feed={f} info={MAIN} onOpenFile={vi.fn()} />)
    act(() => liveInput.push('a', ev))
    expect(getByTestId('office-screen').textContent).toContain('linha nova')
    expect(getByTestId('office-screen').textContent).toContain('ao vivo')
    unmount()
    liveInput.push('a', ev)
    expect(liveInput.latest('a', null)).toBeUndefined()
  })
})
