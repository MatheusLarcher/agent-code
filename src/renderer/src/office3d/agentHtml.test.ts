import { describe, expect, it } from 'vitest'
import type { OfficeFeed } from '../office/adapter/feed'
import type { UIMessage } from '../types'
import { HTML_SHOW_MS, HtmlTracker, isAgentHtml, scanHtmlWrites, type HtmlWrite } from './agentHtml'

const call = (id: string, name: string, input: unknown, result?: { isError: boolean; text: string }): UIMessage =>
  ({ kind: 'tool-use', id, name, input, parentToolUseId: null, ...(result ? { result } : {}) }) as UIMessage
const ok = { isError: false, text: 'ok' }

function feed(messages: UIMessage[], tracks: OfficeFeed['tracks'] = {}): OfficeFeed {
  return {
    conversations: [{ id: 'a', title: 'a', cwd: 'C:\\proj', model: 'm', sdkSessionId: null, messages, tokens: { context: 0, output: 0, cost: 0 }, createdAt: 0, updatedAt: 0 }],
    activeId: 'a', busyIds: new Set(), busySince: {}, permissions: {}, vigiaAlerts: {}, vigiaAt: {}, poDiagnostics: {}, memoristaDiagnostics: {},
    observersOn: { po: false, vigia: false, memorista: false }, stalledSince: {}, tracks, projectIcons: {}
  } as OfficeFeed
}
const principal = { key: 'conv:a', convId: 'a', role: 'principal' as const }

describe('o HTML que o agente cria (agentHtml)', () => {
  it('conta .html/.htm fora das pastas geradas (node_modules, dist, build, out, coverage, *-report)', () => {
    expect(isAgentHtml('C:\\proj\\mockups\\tela.html')).toBe(true)
    expect(isAgentHtml('/home/x/proj/index.HTM')).toBe(true)
    for (const p of ['C:\\proj\\dist\\index.html', 'C:\\proj\\node_modules\\x\\a.html', 'C:\\proj\\build\\a.html', 'C:\\proj\\out\\r.html', 'C:\\proj\\coverage\\index.html', 'C:\\proj\\playwright-report\\index.html', 'C:\\proj\\a.css'])
      expect(isAgentHtml(p), p).toBe(false)
  })

  it('Write e Edit/MultiEdit contam; Bash, Read e NotebookEdit não; o subagente pelos passos da trilha', () => {
    const f = feed(
      [
        call('w1', 'Write', { file_path: 'C:\\proj\\a.html', content: '<h1>' }, ok),
        call('b1', 'Bash', { command: 'echo > C:\\proj\\b.html' }, ok),
        call('r1', 'Read', { file_path: 'C:\\proj\\a.html' }, ok),
        call('e1', 'Edit', { file_path: 'C:\\proj\\a.html', old_string: 'a', new_string: 'b' }, { isError: true, text: 'falhou' }),
        call('w2', 'Write', { file_path: 'C:\\proj\\dist\\index.html' }, ok)
      ],
      { a: { T: { id: 'T', label: 'x', status: 'running', startedAt: 0, stepCount: 1, steps: [{ id: 's1', name: 'MultiEdit', input: { file_path: 'C:\\proj\\b.htm' }, startedAt: 0, result: 'ok' }] } } }
    )
    const writes = scanHtmlWrites(f, [principal, { key: 'track:T', convId: 'a', role: 'subagente', trackId: 'T' }])
    expect(writes.map((w) => [w.id, w.key, w.ok])).toEqual([
      ['e1', 'conv:a', false],
      ['w1', 'conv:a', true],
      ['s1', 'track:T', true]
    ])
  })

  it('o tracker: o histórico do 1º feed não é novo; escrita nova vira a atual; a falha não; some depois de HTML_SHOW_MS', () => {
    const w = (id: string, ok_ = true): HtmlWrite => ({ id, convId: 'a', key: 'conv:a', path: `C:\\proj\\${id}.html`, ok: ok_ })
    const t = new HtmlTracker()
    t.update([w('old')], 1_000)
    expect(t.current(1_000)).toBeNull()
    t.update([w('old'), w('new')], 2_000)
    expect(t.current(2_000)?.id).toBe('new')
    t.update([w('old'), w('new'), w('bad', false)], 3_000)
    expect(t.current(3_000)?.id).toBe('new')
    expect(t.current(2_000 + HTML_SHOW_MS)).toBeNull()
    expect(t.current(3_000, (x) => x.convId === 'outra')).toBeNull()
    // A conversa saiu: some.
    t.update([], 4_000)
    expect(t.current(4_000)).toBeNull()
  })
})
