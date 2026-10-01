import type { MemoristaProviderDiagnosticMsg, PoProviderDiagnosticMsg } from '@shared/ipc'
import { describe, expect, it } from 'vitest'
import { detectTriggers, lastExecutor } from './animTriggers'
import { conv, feed, NOW, track } from './testFeed'

const c = conv('a')
const po = (over: Partial<PoProviderDiagnosticMsg>): PoProviderDiagnosticMsg => ({
  id: 'p1',
  at: NOW,
  conversationId: 'a',
  correlationId: 'k1',
  phase: 'claude-started',
  requestedProvider: 'claude',
  actualProvider: 'claude',
  ...over
})
const mem = (over: Partial<MemoristaProviderDiagnosticMsg>): MemoristaProviderDiagnosticMsg => ({
  id: 'm1',
  at: NOW,
  conversationId: 'a',
  correlationId: 'k1',
  phase: 'claude-started',
  requestedProvider: 'claude',
  actualProvider: 'claude',
  ...over
})

describe('gatilhos das animações 1 a 5', () => {
  it('1: trilha nova de especialista → delegacao; fechou → devolucao com ✗ em erro', () => {
    const f0 = feed({ conversations: [c] })
    const f1 = feed({ conversations: [c], tracks: { a: { t1: track('t1') } } })
    expect(detectTriggers(f0, f1)).toEqual([{ type: 'delegacao', convId: 'a', trackId: 't1', role: 'executor' }])
    const f2 = feed({ conversations: [c], tracks: { a: { t1: track('t1', { status: 'error' }) } } })
    expect(detectTriggers(f1, f2)).toEqual([{ type: 'devolucao', convId: 'a', trackId: 't1', role: 'executor', error: true }])
    // Nada mudou: nada dispara.
    expect(detectTriggers(f2, f2)).toEqual([])
  })

  it('1: subagente genérico não leva pasta', () => {
    const f1 = feed({ conversations: [c], tracks: { a: { g: track('g', { subagentType: 'Explore' }) } } })
    expect(detectTriggers(null, f1)).toEqual([])
  })

  it('2: crítico abre → revisao do executor que trabalhou por último; fecha → veredito antes da devolução', () => {
    const tracks = {
      e1: track('e1', { status: 'done', startedAt: NOW - 50_000 }),
      e2: track('e2', { status: 'done', startedAt: NOW - 30_000 }),
      cr: track('cr', { subagentType: 'critico', startedAt: NOW - 10_000 })
    }
    const f0 = feed({ conversations: [c], tracks: { a: { e1: tracks.e1, e2: tracks.e2 } } })
    const f1 = feed({ conversations: [c], tracks: { a: tracks } })
    expect(detectTriggers(f0, f1)).toEqual([
      { type: 'delegacao', convId: 'a', trackId: 'cr', role: 'critico' },
      { type: 'revisao', convId: 'a', trackId: 'cr', reviewedTrackId: 'e2' }
    ])
    const f2 = feed({ conversations: [c], tracks: { a: { ...tracks, cr: { ...tracks.cr, status: 'error' as const } } } })
    expect(detectTriggers(f1, f2).map((t) => t.type)).toEqual(['veredito', 'devolucao'])
    expect(detectTriggers(f1, f2)[0]).toMatchObject({ reviewedTrackId: 'e2', error: true })
  })

  it('2: sem executor na conversa, revisado = null (vai à mesa do principal)', () => {
    const f1 = feed({ conversations: [c], tracks: { a: { cr: track('cr', { subagentType: 'critico' }) } } })
    expect(detectTriggers(feed({ conversations: [c] }), f1)[1]).toEqual({ type: 'revisao', convId: 'a', trackId: 'cr', reviewedTrackId: null })
    expect(lastExecutor({}, NOW)).toBeNull()
  })

  it('trilhas já rodando no primeiro feed (app abrindo) não disparam delegação nem devolução', () => {
    const f1 = feed({ conversations: [c], tracks: { a: { t1: track('t1'), cr: track('cr', { subagentType: 'critico' }), d: track('d', { status: 'done' }) } } })
    expect(detectTriggers(null, f1)).toEqual([])
    // A partir daí, o que muda dispara normalmente.
    const f2 = feed({ conversations: [c], tracks: { a: { ...f1.tracks.a, t1: track('t1', { status: 'done' }) } } })
    expect(detectTriggers(f1, f2)).toEqual([{ type: 'devolucao', convId: 'a', trackId: 't1', role: 'executor', error: false }])
  })

  it('3: PO em andamento → po (uma vez por rodada); audit-finished → po-fim com appliedOps', () => {
    const f1 = feed({ conversations: [c], poDiagnostics: { a: po({ round: 'open' }) } })
    expect(detectTriggers(feed({ conversations: [c] }), f1)).toEqual([{ type: 'po', convId: 'a', round: 'open' }])
    // Troca de provedor na mesma rodada: não dispara de novo.
    const f2 = feed({ conversations: [c], poDiagnostics: { a: po({ id: 'p2', round: 'open', phase: 'gpt-luna-started' }) } })
    expect(detectTriggers(f1, f2)).toEqual([])
    const f3 = feed({ conversations: [c], poDiagnostics: { a: po({ id: 'p3', round: 'open', phase: 'audit-finished', appliedOps: 2 }) } })
    expect(detectTriggers(f2, f3)).toEqual([{ type: 'po-fim', convId: 'a', cards: 2 }])
    // Observador desligado: nada.
    expect(detectTriggers(null, feed({ ...f1, observersOn: { po: false, vigia: true, memorista: true } }))).toEqual([])
  })

  it('4: vigiaAlerts aparece → vigia; some → vigia-fim', () => {
    const doubt = { at: NOW } as never
    const f1 = feed({ conversations: [c], vigiaAlerts: { a: doubt } })
    expect(detectTriggers(feed({ conversations: [c] }), f1)).toEqual([{ type: 'vigia', convId: 'a' }])
    expect(detectTriggers(f1, feed({ conversations: [c] }))).toEqual([{ type: 'vigia-fim', convId: 'a' }])
  })

  it('5: memorista em andamento → memorista; analysis-finished → memorista-fim com savedMemories', () => {
    const f1 = feed({ conversations: [c], memoristaDiagnostics: { a: mem({}) } })
    expect(detectTriggers(null, f1)).toEqual([{ type: 'memorista', convId: 'a' }])
    const f2 = feed({ conversations: [c], memoristaDiagnostics: { a: mem({ id: 'm2', phase: 'analysis-finished', savedMemories: 0 }) } })
    expect(detectTriggers(f1, f2)).toEqual([{ type: 'memorista-fim', convId: 'a', saved: 0 }])
  })
})
