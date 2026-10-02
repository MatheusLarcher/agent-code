import { describe, expect, it } from 'vitest'
import { contextLimitFor, type PermissionRequest } from '@shared/ipc'
import type { AgentTrack, TrackStep } from '../agentTracks'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel } from '../office/adapter/model'
import { conv, feed, NOW, track } from '../office/adapter/testFeed'
import type { Conversation, UIMessage } from '../types'
import {
  agentStatus,
  clip,
  describeTool,
  diffEvents,
  DONE_MS,
  parseTestSummary,
  shortCommand,
  shortName,
  snapshotOf,
  type AgentEvent,
  type AgentStatus,
  type OfficeSnapshot
} from './events'

type UserMsg = Extract<UIMessage, { kind: 'user' }>
const u = (id: string, text = 'oi', extra: Partial<UserMsg> = {}): UIMessage => ({ kind: 'user', id, text, ...extra })
const tu = (id: string, name: string, input: Record<string, unknown>, result?: string, isError = false): UIMessage => ({
  kind: 'tool-use',
  id,
  name,
  input,
  parentToolUseId: null,
  ...(result === undefined ? {} : { result: { isError, text: result } })
})
const answer = (id: string, ts: number): UIMessage => ({ kind: 'assistant-text', id, text: 'pronto', final: true, answer: true, ts })
const err = (id: string, text: string, usageExhausted = false): UIMessage => ({ kind: 'error', id, text, ...(usageExhausted ? { usageExhausted } : {}) })

/** Uma conversa ativa ('a', em C:\proj\alpha) com estas mensagens. */
function world(messages: UIMessage[], over: Partial<OfficeFeed> = {}, c: Partial<Conversation> = {}): OfficeFeed {
  return feed({ conversations: [conv('a', { messages, updatedAt: NOW - 1_000, ...c })], activeId: 'a', ...over })
}
const busy = (over: Partial<OfficeFeed> = {}): Partial<OfficeFeed> => ({ busyIds: new Set(['a']), busySince: { a: NOW - 5_000 }, ...over })
const snap = (f: OfficeFeed, now = NOW): OfficeSnapshot => snapshotOf(f, deriveOfficeModel(f, now), now)
const diff = (a: OfficeFeed, b: OfficeFeed, t0 = NOW, t1 = NOW + 1_000): AgentEvent[] => diffEvents(snap(a, t0), snap(b, t1), t1)
const types = (evs: AgentEvent[]): string[] => evs.map((e) => e.type)
const main = (f: OfficeFeed, now = NOW): AgentStatus => snap(f, now).agents.get('conv:a')!
const EXECUTOR = 'role:c:/proj/alpha:executor'

const VITEST_FAIL = ' Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 38 passed (39)\n   Duration  1.51s'
const perm = (command: string): PermissionRequest => ({ id: `p-${command}`, toolName: 'Bash', input: { command } })

describe('snapshotOf / diffEvents', () => {
  it('primeiro retrato (prev null) não emite nada, mesmo com histórico', () => {
    const f = world([u('u1'), tu('t1', 'Edit', { file_path: 'C:\\x\\a.ts', old_string: 'a', new_string: 'b' }), err('e1', 'falhou')], busy({ permissions: { a: perm('rm -rf dist') }, stalledSince: { a: NOW - 600_000 } }))
    expect(diffEvents(null, snap(f), NOW)).toEqual([])
    expect(main(f).phase).toBe('waiting-permission')
  })

  it('request: mensagem nova do usuário, numa linha, com mídia legível e até 80 caracteres', () => {
    const long = `Refatora o carrinho {{midia:1}}\n${'e cobre tudo com teste '.repeat(6)}`
    const evs = diff(world([u('u1')]), world([u('u1'), answer('a1', NOW - 500), u('u2', long)], busy()))
    const req = evs.find((e) => e.type === 'request')
    expect(req && req.type === 'request' && req.text).toMatch(/^Refatora o carrinho \[mídia 1\] e cobre/)
    expect(req && req.type === 'request' && req.text.length).toBe(80)
    expect(req?.key).toBe('conv:a')
    // Bolha removida: o último usuário "volta" a ser o anterior — não é pedido novo.
    const back = diff(world([u('u1', 'a', { ts: NOW - 9_000 }), u('u2', 'b', { ts: NOW - 1_000 })]), world([u('u1', 'a', { ts: NOW - 9_000 })]))
    expect(types(back)).not.toContain('request')
  })

  it('tool: chamada nova em andamento, com tipo, alvo curto (basename do caminho Windows) e +N −M', () => {
    const edit = tu('t1', 'Edit', { file_path: 'C:\\proj\\alpha\\src\\total.ts', old_string: 'a\nb', new_string: 'c' })
    const a = world([u('u1')], busy())
    const b = world([u('u1'), edit], busy())
    expect(diff(a, b).filter((e) => e.type === 'tool')).toEqual([{ key: 'conv:a', convId: 'a', at: NOW + 1_000, type: 'tool', name: 'Edit', kind: 'edit', target: 'total.ts' }])
    expect(main(b).tool).toMatchObject({ id: 't1', kind: 'edit', target: 'total.ts', detail: '+1 −2' })
    expect(main(b).phase).toBe('working')
    // A mesma chamada no retrato seguinte não repete o evento.
    expect(types(diff(b, b))).toEqual([])
  })

  it('test-result: saída nova de Bash com resumo; saída sem resumo não dispara', () => {
    const open = tu('b1', 'Bash', { command: 'npm test' })
    const a = world([u('u1'), open], busy())
    const evs = diff(a, world([u('u1'), tu('b1', 'Bash', { command: 'npm test' }, VITEST_FAIL)], busy()))
    expect(evs.filter((e) => e.type === 'test-result')).toMatchObject([{ type: 'test-result', passed: 38, failed: 1 }])
    expect(types(diff(a, world([u('u1'), tu('b1', 'Bash', { command: 'ls' }, 'a.txt\nb.txt')], busy())))).not.toContain('test-result')
  })

  it('permission e permission-done', () => {
    const a = world([u('u1')], busy())
    const b = world([u('u1')], busy({ permissions: { a: perm('cd C:\\proj && rm -rf dist') } }))
    expect(diff(a, b).filter((e) => e.type === 'permission')).toMatchObject([{ type: 'permission', tool: 'Bash', detail: 'rm -rf dist' }])
    expect(main(b)).toMatchObject({ phase: 'waiting-permission', permission: { tool: 'Bash', detail: 'rm -rf dist' } })
    expect(types(diff(b, a))).toEqual(['permission-done'])
    const ask: PermissionRequest = { id: 'q1', toolName: 'AskUserQuestion', input: {}, questions: [{ header: 'Banco', question: 'Qual banco usar?', multiSelect: false, options: [] }] }
    expect(main(world([u('u1')], busy({ permissions: { a: ask } }))).permission).toEqual({ tool: 'AskUserQuestion', detail: 'Qual banco usar?' })
  })

  it('delegate e return: a trilha abre e fecha (ok e com erro)', () => {
    const a = world([u('u1')], busy())
    const running = world([u('u1')], busy({ tracks: { a: { k1: track('k1', { startedAt: NOW }) } } }))
    expect(diff(a, running).filter((e) => e.key === 'conv:a')).toMatchObject([{ type: 'delegate', childKey: EXECUTOR, description: 'k1' }])
    const closed = (status: 'done' | 'error'): OfficeFeed => world([u('u1')], busy({ tracks: { a: { k1: track('k1', { startedAt: NOW, status, endedAt: NOW + 500 }) } } }))
    expect(diff(running, closed('done')).filter((e) => e.type === 'return')).toMatchObject([{ key: 'conv:a', childKey: EXECUTOR, ok: true }])
    expect(diff(running, closed('error')).filter((e) => e.type === 'return')).toMatchObject([{ childKey: EXECUTOR, ok: false }])
  })

  it('done: fim do turno sem erro, com arquivos editados/criados e comandos', () => {
    const p = (f: string): string => `C:\\proj\\alpha\\src\\${f}`
    const work = [
      u('u1'),
      tu('t1', 'Edit', { file_path: p('a.ts'), old_string: 'x', new_string: 'y' }, 'ok'),
      tu('t2', 'Write', { file_path: p('b.ts'), content: 'z' }, 'ok'),
      tu('t3', 'Bash', { command: 'cd C:\\proj\\alpha && npm test' }, 'ok'),
      tu('t4', 'MultiEdit', { file_path: p('a.ts'), edits: [] }, 'ok')
    ]
    const ended = world([...work, answer('a1', NOW + 500)])
    const evs = diff(world(work, busy()), ended)
    expect(evs.filter((e) => e.type === 'done')).toMatchObject([{ key: 'conv:a', summary: { edited: ['a.ts'], created: ['b.ts'], commands: ['npm test'] } }])
    expect(main(ended, NOW + 1_000)).toMatchObject({ phase: 'done', idleSinceMs: NOW + 500, busySinceMs: null })
    expect(main(ended, NOW + 500 + DONE_MS).phase).toBe('idle')
    // Cancelado ou com erro não é 'done'.
    expect(types(diff(world(work, busy()), world([{ ...work[0], canceled: true } as UIMessage, ...work.slice(1)])))).not.toContain('done')
    expect(types(diff(world(work, busy()), world([...work, err('e1', 'boom')])))).not.toContain('done')
  })

  it('error: erro novo no turno (sem o sufixo |segundos); atividade depois dele apaga o erro', () => {
    const a = world([u('u1')], busy())
    const b = world([u('u1'), err('e1', 'Agent stopped: read ECONNRESET|1999999999\nstack…')])
    expect(diff(a, b).filter((e) => e.type === 'error')).toMatchObject([{ key: 'conv:a', message: 'Agent stopped: read ECONNRESET' }])
    expect(main(b)).toMatchObject({ phase: 'error', error: 'Agent stopped: read ECONNRESET' })
    expect(types(diff(a, world([u('u1', 'oi', { error: 'A resposta falhou.' })])))).toContain('error')
    // Erro da API: em português ANTES do corte em 80 — o error.message de um 400 começa depois do 80º caractere.
    const api529 = world([u('u1'), err('e1', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')])
    expect(diff(a, api529).filter((e) => e.type === 'error')).toMatchObject([{ key: 'conv:a', message: 'API sobrecarregada (529)' }])
    const api400 = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}'
    expect(main(world([u('u1'), err('e1', api400)])).error).toBe('prompt is too long: 215000 tokens > 200000 maximum')
    // A recuperação retomou o turno: o erro antigo deixa de valer.
    expect(main(world([u('u1'), err('e1', 'boom'), tu('t1', 'Read', { file_path: 'x.ts' })], busy()))).toMatchObject({ phase: 'working', error: null })
  })

  it('context-low: só ao cruzar 20% e 10% de contexto restante, para baixo', () => {
    const at = (pct: number): OfficeFeed => world([u('u1')], {}, { tokens: { context: Math.round(contextLimitFor('claude-opus-4-5') * (1 - pct / 100)), output: 0, cost: 0 } })
    const lows = (a: number, b: number): AgentEvent[] => diff(at(a), at(b)).filter((e) => e.type === 'context-low')
    expect(main(at(25)).contextPct).toBe(25)
    expect(lows(25, 19)).toMatchObject([{ pct: 19 }])
    expect(lows(19, 15)).toEqual([])
    expect(lows(15, 9)).toMatchObject([{ pct: 9 }])
    expect(lows(9, 30)).toEqual([])
    expect(lows(30, 5)).toHaveLength(1)
    expect(main(world([u('u1')])).contextPct).toBeNull()
  })

  it('usage-exhausted e usage-back: limite da própria conversa, até a recuperação ou o reset', () => {
    const limit = err('e1', 'Claude AI usage limit reached|1800000060', true)
    const recovery = { id: 'r', reason: 'limit' as const, scheduledAt: NOW + 90_000, attempt: 0, maxAttempts: 5, errorText: 'x', messageId: 'u1' }
    const a = world([u('u1')], busy())
    const out = world([u('u1'), limit], busy({ busySince: {} }), { recovery })
    expect(diff(a, out).filter((e) => e.type === 'usage-exhausted')).toMatchObject([{ resetsAt: NOW + 90_000 }])
    expect(main(out)).toMatchObject({ phase: 'error', usageExhausted: { resetsAt: NOW + 90_000 }, busySinceMs: null })
    // Sem recuperação, o horário vem do texto ("|segundos").
    expect(main(world([u('u1'), limit])).usageExhausted).toEqual({ resetsAt: 1_800_000_060_000 })
    // Recuperou: a recuperação sai e o turno segue.
    expect(types(diff(out, world([u('u1'), limit, tu('t1', 'Read', { file_path: 'x.ts' })], busy())))).toContain('usage-back')
    // Ou o reset passou.
    expect(types(diffEvents(snap(out, NOW), snap(out, NOW + 91_000), NOW + 91_000))).toContain('usage-back')
    // Janela rejeitada sozinha não marca ninguém (não se sabe de qual conta é).
    const rejected = world([u('u1')], { usageLimits: { five_hour: { rateLimitType: 'five_hour', status: 'rejected', resetsAt: NOW + 1 } } })
    expect(main(rejected).usageExhausted).toBeNull()
  })

  it('stalled: ao cruzar 2 min sem sinal de vida (feed.stalledSince)', () => {
    const f = world([u('u1')], busy({ stalledSince: { a: NOW - 100_000 } }))
    expect(main(f).stalledMs).toBe(100_000)
    expect(diffEvents(snap(f, NOW), snap(f, NOW + 30_000), NOW + 30_000).filter((e) => e.type === 'stalled')).toMatchObject([{ ms: 130_000 }])
    expect(types(diffEvents(snap(f, NOW + 30_000), snap(f, NOW + 40_000), NOW + 40_000))).toEqual([])
    expect(main(world([u('u1')], busy())).stalledMs).toBe(0)
  })

  it('speaking: a voz começa e para de ler uma mensagem do turno atual', () => {
    const msgs = [u('u1'), answer('a1', NOW - 500)]
    const on = world(msgs, { speakingId: 'a1' })
    expect(diff(world(msgs), on).filter((e) => e.type === 'speaking')).toMatchObject([{ on: true }])
    expect(diff(on, world(msgs)).filter((e) => e.type === 'speaking')).toMatchObject([{ on: false }])
    // Mensagem de um turno anterior: fora do custo O(turno), não acende.
    expect(main(world([u('u0'), answer('a0', 1), u('u1')], { speakingId: 'a0' })).speaking).toBe(false)
  })

  it('subagente: ferramenta, test-result, done e error na própria trilha', () => {
    const step = (id: string, name: string, input: Record<string, unknown>, result?: string): TrackStep => ({ id, name, input, startedAt: NOW, ...(result === undefined ? {} : { endedAt: NOW, result }) })
    const at = (steps: TrackStep[], over: Partial<AgentTrack> = {}): OfficeFeed =>
      world([u('u1'), tu('k1', 'Agent', { subagent_type: 'executor' })], busy({ tracks: { a: { k1: track('k1', { startedAt: NOW, steps, ...over }) } } }))
    const reading = at([step('s1', 'Read', { file_path: 'C:\\proj\\alpha\\src\\leia.ts' })])
    expect(snap(reading).agents.get(EXECUTOR)).toMatchObject({ phase: 'working', trackId: 'k1', tool: { kind: 'read', target: 'leia.ts' }, busySinceMs: NOW, lastUserText: 'oi' })
    const tested = at([step('s1', 'Read', {}, 'ok'), step('s2', 'Bash', { command: 'npm test' }, VITEST_FAIL)])
    expect(diff(reading, tested).filter((e) => e.key === EXECUTOR && e.type === 'test-result')).toMatchObject([{ passed: 38, failed: 1 }])
    const done = at([step('s2', 'Edit', { file_path: 'C:\\x\\b.ts', old_string: '', new_string: 'x' }, 'ok')], { status: 'done', endedAt: NOW + 500 })
    expect(diff(reading, done).filter((e) => e.key === EXECUTOR)).toMatchObject([{ type: 'done', summary: { edited: ['b.ts'], created: [], commands: [] } }])
    const failed = at([], { status: 'error', endedAt: NOW + 500 })
    expect(diff(reading, failed).filter((e) => e.key === EXECUTOR)).toMatchObject([{ type: 'error', message: 'subagente terminou com erro' }])
  })

  it('personagem que aparece agora é linha de base: só o pedido de um turno novo dispara', () => {
    const a = world([u('u1')])
    const fresh = conv('b', { messages: [u('ub', 'novo pedido', { ts: NOW + 500 })], updatedAt: NOW + 500 })
    const old = conv('c', { messages: [u('uc', 'antigo', { ts: NOW - 600_000 }), err('ec', 'falhou')], updatedAt: NOW - 600_000 })
    const b = feed({ conversations: [...a.conversations, fresh, old], activeId: 'a', busyIds: new Set(['b']), busySince: { b: NOW + 500 } })
    expect(diff(a, b)).toMatchObject([{ key: 'conv:b', type: 'request', text: 'novo pedido' }])
  })

  it('agentStatus de um personagem é o mesmo do retrato', () => {
    const f = world([u('u1'), tu('t1', 'Grep', { pattern: 'useState', path: 'C:\\proj\\alpha\\src' })], busy())
    const ch = deriveOfficeModel(f, NOW).characters[0]
    expect(agentStatus(f, ch, NOW)).toEqual(main(f))
    expect(main(f).tool).toMatchObject({ kind: 'search', target: 'useState', detail: 'src' })
  })
})

describe('parseTestSummary', () => {
  it('vitest: lê a linha Tests, não a Test Files', () => {
    expect(parseTestSummary(VITEST_FAIL)).toEqual({ passed: 38, failed: 1 })
    expect(parseTestSummary(' Test Files  3 passed (3)\n      Tests  39 passed (39)\n   Duration  1.42s')).toEqual({ passed: 39, failed: 0 })
    expect(parseTestSummary('      Tests  2 failed | 5 passed | 1 skipped (8)')).toEqual({ passed: 5, failed: 2 })
    expect(parseTestSummary('\x1b[32m      Tests  \x1b[1m5 passed\x1b[22m (5)\x1b[39m')).toEqual({ passed: 5, failed: 0 })
  })

  it('jest', () => {
    expect(parseTestSummary('FAIL src/a.spec.ts\n\nTest Suites: 1 failed, 4 passed, 5 total\nTests:       1 failed, 23 passed, 24 total\nTime:        3.2 s')).toEqual({ passed: 23, failed: 1 })
    expect(parseTestSummary('Tests:       24 passed, 24 total')).toEqual({ passed: 24, failed: 0 })
  })

  it('pytest: com e sem as barras, erros de coleta contam como falha', () => {
    expect(parseTestSummary('collected 18 items\n\n=========== 1 failed, 17 passed, 2 warnings in 0.91s ===========')).toEqual({ passed: 17, failed: 1 })
    expect(parseTestSummary('..................\n18 passed in 0.84s')).toEqual({ passed: 18, failed: 0 })
    expect(parseTestSummary('==== 1 passed, 2 errors in 0.40s ====')).toEqual({ passed: 1, failed: 2 })
  })

  it('go test: casos com -v, senão os pacotes', () => {
    expect(parseTestSummary('=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n    --- PASS: TestB/sub (0.00s)\nFAIL')).toEqual({ passed: 2, failed: 1 })
    expect(parseTestSummary('ok  \texample.com/a\t0.012s\nok  \texample.com/b\t(cached)\nFAIL\texample.com/c\t0.020s\n?   \texample.com/d\t[no test files]')).toEqual({ passed: 2, failed: 1 })
  })

  it('saída sem resumo de teste → null', () => {
    expect(parseTestSummary('added 12 packages in 9s')).toBeNull()
    expect(parseTestSummary('')).toBeNull()
  })
})

describe('alvo e truncamento', () => {
  it('caminho Windows ou POSIX → basename', () => {
    expect(shortName('C:\\Users\\mathe\\proj\\src\\deep\\total.ts')).toBe('total.ts')
    expect(shortName('/home/dev/app/main.py')).toBe('main.py')
    expect(shortName('C:\\proj\\src\\')).toBe('src')
    expect(shortName('')).toBe('')
    expect(describeTool('t', 'Write', { file_path: 'D:\\obra\\docs\\NOTAS.md', content: 'a\nb\nc' })).toMatchObject({ kind: 'write', target: 'NOTAS.md', detail: '+3' })
  })

  it('texto vira uma linha cortada com "…" no limite', () => {
    expect(clip('  a\n\tb  ', 10)).toBe('a b')
    const long = clip('x'.repeat(100), 40)
    expect(long).toHaveLength(40)
    expect(long.endsWith('…')).toBe(true)
    expect(shortName(`C:\\p\\${'n'.repeat(60)}.ts`)).toHaveLength(40)
  })

  it('comando: 1ª linha, sem os "cd pasta &&" da frente, até 40', () => {
    expect(shortCommand('cd "C:\\a b" && cd src; npm test -- --run\necho fim')).toBe('npm test -- --run')
    expect(shortCommand('\n  git status')).toBe('git status')
    expect(shortCommand(`npx vitest run ${'src/office3d/'.repeat(5)}`)).toHaveLength(40)
    expect(describeTool('t', 'Bash', { command: 'rm -rf dist', description: 'Limpa a saída' })).toMatchObject({ kind: 'bash', target: 'rm -rf dist', detail: 'Limpa a saída' })
  })

  it('tipos: web (host), task (subagente), outros', () => {
    expect(describeTool('t', 'WebFetch', { url: 'https://docs.anthropic.com/pt/api', prompt: 'resume' })).toMatchObject({ kind: 'web', target: 'docs.anthropic.com' })
    expect(describeTool('t', 'mcp__browser__browser_navigate', { url: 'http://localhost:5173/' })).toMatchObject({ kind: 'web', target: 'localhost:5173' })
    expect(describeTool('t', 'Agent', { subagent_type: 'critico', description: 'revisar o diff' })).toMatchObject({ kind: 'task', target: 'critico', detail: 'revisar o diff' })
    expect(describeTool('t', 'mcp__tasks__task_get', { task_id: 'x' })).toMatchObject({ kind: 'other', target: '' })
    expect(describeTool('t', 'PowerShell', { command: 'Get-ChildItem' }).kind).toBe('bash')
  })
})
