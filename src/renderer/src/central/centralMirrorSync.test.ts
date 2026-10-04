import { describe, expect, it } from 'vitest'
import type { CentralEntry, CentralReplyEntry, CentralRequestEntry } from '@shared/central'
import type { Conversation, UIMessage } from '../types'
import { ANSWER_MAX_CHARS, MAX_REPLY_NOTES, replyIdFor } from './centralEntries'
import { applyMirror, planMirror } from './centralMirrorSync'

/**
 * O espelho (puro): de cada pedido ancorado sem resposta terminada sai UMA
 * resposta — criada quando o turno começa, depois atualizada no lugar —, só para
 * as entradas deste PC; resposta de âncora velha sai; destino fora da tela vai
 * para o re-link.
 */

const user = (id: string, injected = false): UIMessage => ({ kind: 'user', id, text: id, ...(injected ? { injected: true } : {}) })
const text = (id: string, t: string, o: { final?: boolean; answer?: boolean } = {}): UIMessage => ({
  kind: 'assistant-text',
  id,
  text: t,
  final: o.final ?? true,
  ...(o.answer ? { answer: true } : {})
})
const read = (id: string, file: string, parent: string | null = null): UIMessage => ({
  kind: 'tool-use',
  id,
  name: 'Read',
  input: { file_path: file },
  parentToolUseId: parent,
  result: { isError: false, text: 'ok' }
})

const conv = (id: string, messages: UIMessage[]): Conversation =>
  ({ id, cwd: 'C:\\proj\\alpha', title: id, model: 'm', sdkSessionId: null, messages, tokens: { context: 0, output: 0, cost: 0 }, createdAt: 1, updatedAt: 1 }) as Conversation

const req = (id: string, convId: string, msgId: string, extra: Partial<CentralRequestEntry> = {}): CentralRequestEntry => ({
  kind: 'request',
  id,
  ts: 1,
  text: id,
  state: 'delivered',
  anchor: { convId, msgId },
  ...extra
})

const plan = (entries: CentralEntry[], convs: Conversation[], busy: string[] = [], self = 'pc-1') =>
  planMirror({ entries, convs: new Map(convs.map((c) => [c.id, c])), busy: new Set(busy), self, now: 500 })

describe('planMirror', () => {
  it('turno ainda não começou (ou mensagem na fila): nada', () => {
    const r = req('r1', 'c1', 'u1')
    expect(plan([r], [conv('c1', [user('u1')])], ['c1']).upserts).toEqual([])
    expect(plan([r], [conv('c1', [])], ['c1']).upserts).toEqual([])
  })

  it('primeiro conteúdo cria a resposta (id reply:<pedido>, ts agora, device deste PC)', () => {
    const r = req('r1', 'c1', 'u1')
    const { upserts } = plan([r], [conv('c1', [user('u1'), text('t1', 'Vou olhar o filtro.'), read('k1', 'src/filtros.js')])], ['c1'])
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({
      kind: 'reply',
      id: replyIdFor('r1'),
      ts: 500,
      requestId: 'r1',
      anchor: { convId: 'c1', msgId: 'u1' },
      notes: ['Vou olhar o filtro.'],
      done: false,
      device: 'pc-1'
    })
    expect(upserts[0].activity.count).toBe(1)
    expect(upserts[0]).not.toHaveProperty('answer')
  })

  it('resposta existente: atualiza no lugar (mesmo id e ts); conteúdo igual não gera upsert', () => {
    const r = req('r1', 'c1', 'u1')
    const msgs = [user('u1'), text('t1', 'Olhando.'), text('t2', 'Pronto: filtro arrumado.', { answer: true })]
    const first = plan([r], [conv('c1', msgs)], [])
    const reply = first.upserts[0]
    expect(reply).toMatchObject({ answer: 'Pronto: filtro arrumado.', notes: ['Olhando.'], done: true })
    // A resposta gravada antes de o turno terminar (ainda sem as notas e sem o fim).
    const old: CentralReplyEntry = { ...reply, ts: 42, notes: [], done: false }
    const again = plan([r, old], [conv('c1', msgs)], [])
    expect(again.upserts).toEqual([{ ...reply, ts: 42 }])
    expect(plan([r, reply], [conv('c1', msgs)], []).upserts).toEqual([])
  })

  it('resposta terminada fica parada; volta a espelhar se o MESMO turno roda de novo (reenvio)', () => {
    const r = req('r1', 'c1', 'u1')
    const done: CentralReplyEntry = { kind: 'reply', id: 'reply:r1', ts: 9, requestId: 'r1', anchor: { convId: 'c1', msgId: 'u1' }, notes: [], activity: { segments: [], text: '', count: 0, errors: 0 }, done: true }
    const msgs = [user('u1'), text('t1', 'De novo.')]
    expect(plan([r, done], [conv('c1', msgs)], []).upserts).toEqual([])
    expect(plan([r, done], [conv('c1', msgs)], ['c1']).upserts[0]).toMatchObject({ notes: ['De novo.'], done: false })
    // Ocupada com OUTRO turno: a resposta velha continua parada.
    expect(plan([r, done], [conv('c1', [...msgs, user('u2')])], ['c1']).upserts).toEqual([])
  })

  it('subagente, texto parcial e pensamento nunca viram nota', () => {
    const r = req('r1', 'c1', 'u1')
    const msgs = [user('u1'), read('k1', 'a.ts'), read('k2', 'sub.ts', 'k0'), text('p', 'parcial', { final: false })]
    const [reply] = plan([r], [conv('c1', msgs)], ['c1']).upserts
    expect(reply.notes).toEqual([])
    expect(reply.activity.count).toBe(1)
  })

  it('só escreve as entradas deste PC (as do outro PC, ele espelha); injetada nunca tem resposta', () => {
    const msgs = [user('u1'), text('t1', 'oi'), user('u2', true)]
    const entries = [req('r1', 'c1', 'u1', { device: 'pc-2' }), req('r2', 'c1', 'u2', { injected: true })]
    expect(plan(entries, [conv('c1', msgs)], ['c1']).upserts).toEqual([])
    expect(plan([req('r3', 'c1', 'u1')], [conv('c1', msgs)], ['c1'], 'pc-1').upserts).toHaveLength(1)
  })

  it('resposta com âncora diferente da atual do pedido sai (nunca o conteúdo do destino antigo)', () => {
    const r = req('r1', 'c2', 'u9')
    const stale: CentralReplyEntry = { kind: 'reply', id: 'reply:r1', ts: 9, requestId: 'r1', anchor: { convId: 'c1', msgId: 'u1' }, notes: ['velha'], activity: { segments: [], text: '', count: 0, errors: 0 }, done: true }
    const p = plan([r, stale], [conv('c1', [user('u1'), text('t', 'velha')]), conv('c2', [user('u9')])], ['c2'])
    expect(p.removals).toEqual(['r1'])
    expect(p.upserts).toEqual([])
  })

  it('destino fora da tela: re-link só de turno que começou e não terminou (o que nunca rodou não recarrega a cada boot)', () => {
    const started: CentralReplyEntry = { kind: 'reply', id: 'reply:r1', ts: 9, requestId: 'r1', anchor: { convId: 'longe', msgId: 'u1' }, notes: ['olhando'], activity: { segments: [], text: '', count: 0, errors: 0 }, done: false }
    const p = plan([req('r1', 'longe', 'u1'), started, req('r2', 'c1', 'u2'), req('r3', 'nunca-rodou', 'u3')], [conv('c1', [user('u2')])])
    expect(p.missing).toEqual(['longe'])
  })

  it('tetos: 12 notas e a resposta cortada', () => {
    const notes = Array.from({ length: 14 }, (_, i) => text(`t${i}`, `nota ${i}`))
    const msgs = [user('u1'), ...notes, text('ta', 'z'.repeat(ANSWER_MAX_CHARS + 5), { answer: true })]
    const [reply] = plan([req('r1', 'c1', 'u1')], [conv('c1', msgs)]).upserts
    expect(reply.notes).toHaveLength(MAX_REPLY_NOTES)
    expect(reply.notes[0]).toBe('nota 2')
    expect(reply.answer).toHaveLength(ANSWER_MAX_CHARS)
  })
})

describe('applyMirror', () => {
  it('aplica remoções e upserts sobre o estado mais novo; pedido que mudou de âncora não recebe a resposta velha', () => {
    const r1 = req('r1', 'c1', 'u1')
    const reply: CentralReplyEntry = { kind: 'reply', id: 'reply:r1', ts: 5, requestId: 'r1', anchor: { convId: 'c1', msgId: 'u1' }, notes: ['oi'], activity: { segments: [], text: '', count: 0, errors: 0 }, done: false }
    const fresh = applyMirror({ entries: [r1, req('r2', 'c2', 'u2')] }, { upserts: [reply], removals: [], missing: [] })
    expect(fresh.entries.map((e) => e.id)).toEqual(['r1', 'r2', 'reply:r1'])
    // Entre o cálculo e a aplicação, "não era aqui" tirou a âncora do pedido.
    const moved = applyMirror({ entries: [{ ...r1, anchor: undefined, state: 'asking' }] }, { upserts: [reply], removals: [], missing: [] })
    expect(moved.entries.map((e) => e.id)).toEqual(['r1'])
    const removed = applyMirror({ entries: [r1, reply] }, { upserts: [], removals: ['r1'], missing: [] })
    expect(removed.entries.map((e) => e.id)).toEqual(['r1'])
  })
})
