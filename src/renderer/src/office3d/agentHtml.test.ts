import { describe, expect, it } from 'vitest'
import type { OfficeFeed } from '../office/adapter/feed'
import type { UIMessage } from '../types'
import { freshHtmlWrite, HTML_SHOW_MS, HtmlTracker, isAgentHtml, scanHtmlWrites, type HtmlWrite } from './agentHtml'

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

  it('acabou de criar (o clique no agente abre a Prévia): a última escrita que deu certo, do turno em andamento ou fechado há menos de HTML_SHOW_MS', () => {
    const NOW = 10 * HTML_SHOW_MS
    const ask = (id: string): UIMessage => ({ kind: 'user', id, text: 'faz a tela' })
    const answer = (ts: number): UIMessage => ({ kind: 'assistant-text', id: `t${ts}`, text: 'pronto', final: true, answer: true, ts }) as UIMessage
    const write = call('w1', 'Write', { file_path: 'C:\\proj\\tela.html', content: '<h1>' }, ok)
    const fresh = (f: OfficeFeed): string | null => freshHtmlWrite(f, principal, NOW)?.id ?? null
    const busy = (f: OfficeFeed): OfficeFeed => ({ ...f, busyIds: new Set(['a']) })
    // Trabalhando no turno dela: vale, sem olhar relógio.
    expect(fresh(busy(feed([ask('u1'), write])))).toBe('w1')
    // Turno fechado: a resposta diz quando; há 2 min vale, há 6 min não.
    expect(fresh(feed([ask('u1'), write, answer(NOW - 2 * 60_000)]))).toBe('w1')
    expect(fresh(feed([ask('u1'), write, answer(NOW - 6 * 60_000)]))).toBeNull()
    // Sem relógio no feed: vale o turno atual; o turno anterior, não.
    expect(fresh(feed([ask('u1'), write]))).toBe('w1')
    expect(fresh(busy(feed([ask('u1'), write, ask('u2')])))).toBeNull()
    // Turno anterior fechado há 1 min, com outro em andamento: ainda vale.
    expect(fresh(busy(feed([ask('u1'), write, answer(NOW - 60_000), ask('u2')])))).toBe('w1')
    // O ajuste do botão "agora" (injected) entra no turno em andamento: não o fecha.
    expect(fresh(busy(feed([ask('u1'), write, { kind: 'user', id: 'u2', text: 'muda a cor', injected: true }])))).toBe('w1')
    // A escrita que falhou não conta; a anterior que deu certo, sim.
    const bad = call('e1', 'Edit', { file_path: 'C:\\proj\\tela.html', old_string: 'a', new_string: 'b' }, { isError: true, text: 'falhou' })
    expect(fresh(busy(feed([ask('u1'), write, bad])))).toBe('w1')
    expect(fresh(busy(feed([ask('u1'), bad])))).toBeNull()
    // Subagente: a trilha rodando vale; terminada, o fim do passo diz quando.
    const sub = { key: 'track:T', convId: 'a', role: 'subagente' as const, trackId: 'T' }
    const trackFeed = (status: 'running' | 'done', endedAt: number): OfficeFeed =>
      feed([], { a: { T: { id: 'T', label: 'x', status, startedAt: 0, stepCount: 1, steps: [{ id: 's1', name: 'Write', input: { file_path: 'C:\\proj\\b.html' }, startedAt: 0, endedAt, result: 'ok' }] } } })
    expect(freshHtmlWrite(trackFeed('running', 0), sub, NOW)?.id).toBe('s1')
    expect(freshHtmlWrite(trackFeed('done', NOW - 60_000), sub, NOW)?.id).toBe('s1')
    expect(freshHtmlWrite(trackFeed('done', NOW - HTML_SHOW_MS), sub, NOW)).toBeNull()
  })
})
