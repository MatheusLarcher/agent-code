import { describe, expect, it } from 'vitest'
import type { OfficeFeed } from '../office/adapter/feed'
import type { UIMessage } from '../types'
import { callPath, CallMarks, CallQueue, openCalls } from './officeCalls'

const NOW = 1_800_000_000_000
const TOOL = 'mcp__app__app_chamar_usuario'
const ok = { isError: false, text: 'ok' }
const call = (id: string, input: unknown, result: UIMessage['result'] | null = ok, parent: string | null = null): UIMessage =>
  ({ kind: 'tool-use', id, name: TOOL, input, parentToolUseId: parent, ...(result ? { result } : {}) }) as UIMessage
const user = (id: string): UIMessage => ({ kind: 'user', id, text: 'oi' }) as UIMessage
const task = (id: string): UIMessage => ({ kind: 'tool-use', id, name: 'Task', input: {}, parentToolUseId: null, result: ok }) as UIMessage

function feed(convs: Array<{ id: string; messages: UIMessage[]; updatedAt?: number; cwd?: string }>, tracks: OfficeFeed['tracks'] = {}): OfficeFeed {
  return {
    conversations: convs.map((c) => ({ id: c.id, title: c.id, cwd: c.cwd ?? 'C:\\proj', model: 'm', sdkSessionId: null, messages: c.messages, tokens: { context: 0, output: 0, cost: 0 }, createdAt: 0, updatedAt: c.updatedAt ?? NOW })),
    activeId: null, busyIds: new Set(), busySince: {}, permissions: {}, vigiaAlerts: {}, vigiaAt: {}, poDiagnostics: {}, memoristaDiagnostics: {},
    observersOn: { po: false, vigia: false, memorista: false }, stalledSince: {}, tracks, projectIcons: {}
  } as unknown as OfficeFeed
}
const none = (): boolean => false

describe('o chamado tirado das mensagens (openCalls)', () => {
  it('a chamada que deu certo abre; com erro ou sem resultado, não; o caminho relativo resolve no cwd; a mensagem vem junto', () => {
    const f = feed([
      { id: 'a', messages: [user('u1'), call('c1', { arquivo: 'mockups\\tela.html', mensagem: ' veja ' })] },
      { id: 'b', messages: [user('u2'), call('c2', { arquivo: 'C:\\proj\\b.html' }, { isError: true, text: 'Recusado' })] },
      { id: 'c', messages: [user('u3'), call('c3', { arquivo: 'C:\\proj\\c.html' }, null)] }
    ])
    expect(openCalls(f, NOW, none)).toEqual([{ id: 'c1', convId: 'a', key: 'conv:a', cwd: 'C:\\proj', path: 'C:\\proj\\mockups\\tela.html', mensagem: 'veja' }])
  })

  it('acaba: respondido (mensagem do usuário depois), aberto/cancelado (marca); conversa fora do escritório não chama; vale o último chamado do agente', () => {
    const answered = feed([{ id: 'a', messages: [call('c1', { arquivo: 'a.html' }), user('u1')] }])
    expect(openCalls(answered, NOW, none)).toEqual([])
    const twice = feed([{ id: 'a', messages: [call('c1', { arquivo: 'a.html' }), call('c2', { arquivo: 'b.html' })] }])
    expect(openCalls(twice, NOW, none).map((c) => c.id)).toEqual(['c2'])
    expect(openCalls(twice, NOW, (id) => id === 'c2')).toEqual([])
    const old = feed([{ id: 'a', messages: [call('c1', { arquivo: 'a.html' })], updatedAt: NOW - 13 * 3600_000 }])
    expect(openCalls(old, NOW, none)).toEqual([])
  })

  it('o subagente chama pelo principal (a trilha desta leva); trilha de antes da resposta do usuário não conta', () => {
    const step = (id: string) => ({ id, name: TOOL, input: { arquivo: 'C:\\proj\\s.html' }, startedAt: 0, result: 'ok' })
    const f = feed(
      [{ id: 'a', messages: [task('T0'), user('u1'), task('T1')] }],
      { a: { T0: { id: 'T0', label: '', status: 'done', startedAt: 0, stepCount: 1, steps: [step('s0')] }, T1: { id: 'T1', label: '', status: 'running', startedAt: 0, stepCount: 1, steps: [step('s1')] } } }
    )
    expect(openCalls(f, NOW, none)).toEqual([{ id: 's1', convId: 'a', key: 'conv:a', cwd: 'C:\\proj', path: 'C:\\proj\\s.html', mensagem: null }])
  })

  it('callPath: absoluto fica; relativo junta ao cwd com o separador dele', () => {
    expect(callPath('/x/a.html', '/home/p')).toBe('/x/a.html')
    expect(callPath('./m/a.html', '/home/p/')).toBe('/home/p/m/a.html')
    expect(callPath('m/a.html', 'C:\\p')).toBe('C:\\p\\m\\a.html')
  })
})

describe('a fila e as marcas', () => {
  it('CallQueue: a ordem de chegada; quem saiu sai da fila', () => {
    const q = new CallQueue()
    const c = (id: string) => ({ id, convId: id, key: `conv:${id}`, cwd: '', path: '', mensagem: null })
    expect(q.order([c('b')], 1).map((x) => x.id)).toEqual(['b'])
    expect(q.order([c('a'), c('b')], 2).map((x) => x.id)).toEqual(['b', 'a'])
    expect(q.order([c('a')], 3).map((x) => x.id)).toEqual(['a'])
    expect(q.sinceOf('b')).toBeNull()
  })

  it('CallMarks: guarda entre recargas, avisa quem assina, não marca duas vezes', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    const m = new CallMarks(storage)
    let n = 0
    const off = m.subscribe(() => n++)
    m.end('c1', 'aberto')
    m.end('c1', 'cancelado')
    expect(n).toBe(1)
    off()
    expect(new CallMarks(storage).ended('c1')).toBe(true)
    expect(new CallMarks({ getItem: () => '{quebrado', setItem: () => {} }).ended('c1')).toBe(false)
  })
})
