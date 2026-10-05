import { describe, expect, it } from 'vitest'
import { deriveOfficeModel, roomIdFor } from '../../office/adapter/model'
import { conv, feed, NOW } from '../../office/adapter/testFeed'
import { BIN, PAD } from '../brainBoard'
import { stepLine, summaryLine, USER_SEAL } from './boardLines'
import { BoardChoreo, LAG_MS, motionOf, performerOf, STEP_S, stopsFor, TRIP_CAP, TRIP_CAP_BUSY, type ChoreoCtx } from './boardChoreo'
import type { BoardStep } from './boardModel'

const step = (o: Partial<BoardStep> = {}): BoardStep => ({
  roomId: 'r',
  cardId: 'c1',
  kind: 'moved',
  actor: 'agent',
  text: 'mudou para concluído',
  at: '2026-10-04T00:00:00.000Z',
  toStatus: 'completed',
  convId: 'k1',
  title: 'Gerar o instalador',
  activeForm: null,
  ...o
})

function ctx(o: Partial<ChoreoCtx> = {}): ChoreoCtx {
  return { available: () => true, walkS: () => 4, fromColumn: () => 0, ...o }
}

describe('as falas do quadro (o texto nunca troca o autor)', () => {
  it('agente em primeira pessoa, gerada do dado; no selo, terceira pessoa', () => {
    expect(stepLine(step(), true)).toBe('Concluí: Gerar o instalador')
    expect(stepLine(step(), false)).toBe('O agente concluiu: Gerar o instalador')
    expect(stepLine(step({ toStatus: 'in_progress', activeForm: 'Gerando o instalador' }), true)).toBe('Comecei: Gerando o instalador')
    expect(stepLine(step({ kind: 'new', toStatus: 'pending' }), true)).toBe('Anotei: Gerar o instalador')
    expect(stepLine(step({ kind: 'removed', toStatus: null }), true)).toBe('Tirei do plano: Gerar o instalador')
    expect(stepLine(step({ kind: 'restored', toStatus: 'pending' }), true)).toContain('Gerar o instalador')
    expect(stepLine(step({ kind: 'renamed' }), true)).toBe('Reescrevi: Gerar o instalador')
  })

  it('PO fala o motivo real dele', () => {
    expect(stepLine(step({ actor: 'po', text: 'falta rodar no app de verdade' }), true)).toBe('falta rodar no app de verdade')
    expect(stepLine(step({ actor: 'po', text: 'falta rodar no app de verdade' }), false)).toBe('PO: falta rodar no app de verdade')
  })

  it('sistema é regra, nunca decisão do PO em primeira pessoa', () => {
    const end = step({ actor: 'system', toStatus: 'pending', text: 'o turno terminou sem concluir esta tarefa' })
    expect(stepLine(end, true)).toBe('Regra do fim do turno: o turno terminou sem concluir esta tarefa')
    expect(stepLine(end, false)).toBe('Sistema — fim do turno: o turno terminou sem concluir esta tarefa')
    const back = step({ actor: 'system', toStatus: 'in_progress', text: 'o usuário retomou a conversa' })
    expect(stepLine(back, true)).toBe('Regra da retomada: você respondeu, o trabalho voltou')
    for (const s of [end, back, step({ actor: 'system', kind: 'removed', text: 'concluído há mais de 5 dias' })]) {
      expect(stepLine(s, true)).toMatch(/^Regra /)
      expect(stepLine(s, false)).toMatch(/^Sistema/)
    }
  })

  it('usuário e autor desconhecido não falam; corta em 72 com "…"', () => {
    expect(stepLine(step({ actor: 'user' }), true)).toBeNull()
    expect(stepLine(step({ actor: null }), true)).toBeNull()
    const long = stepLine(step({ title: 'x'.repeat(200) }), true) as string
    expect(long.length).toBe(72)
    expect(long.endsWith('…')).toBe(true)
  })

  it('fala-resumo do excedente', () => {
    expect(summaryLine(['complete', 'complete', 'complete', 'write', 'write'])).toBe('+5 mudanças: 3 concluídas, 2 novas')
  })
})

describe('coreografia por tipo de mudança', () => {
  const fires = (st: ReturnType<typeof stopsFor>): number => st.reduce((n, s) => n + s.beats.filter((b) => b.fire).length, 0)

  it('cada tipo: paradas e o instante em que o papel muda', () => {
    const write = stopsFor(step({ kind: 'new', toStatus: 'pending' }), null, 0)
    expect(write.map((s) => s.col)).toEqual([PAD, 0])
    expect(write[0].beats[0].action).toBe('scribble')
    const move = stopsFor(step({ toStatus: 'in_progress' }), 0, 0)
    expect(move.map((s) => s.col)).toEqual([0, 1])
    expect(move[0].beats[0].action).toBe('unpin')
    expect(move[1].beats[0]).toMatchObject({ action: 'stick', prop: 'note', fire: true })
    const done = stopsFor(step(), 1, 0)
    expect(done[1].beats.map((b) => b.action)).toContain('stamp')
    expect(stopsFor(step({ kind: 'renamed' }), 1, 0)[0].beats[0].action).toBe('scribble')
    expect(stopsFor(step({ kind: 'justified' }), 1, 0)[0].beats[0].action).toBe('point')
    const trash = stopsFor(step({ kind: 'removed', toStatus: null }), 2, 0)
    expect(trash.map((s) => s.col)).toEqual([2, BIN])
    expect(trash[1].beats[0].action).toBe('crumple')
    expect(stopsFor(step({ kind: 'restored', toStatus: 'pending' }), null, 0).map((s) => s.col)).toEqual([BIN, 0])
    for (const k of ['new', 'moved', 'renamed', 'justified', 'removed', 'restored'] as const) expect(fires(stopsFor(step({ kind: k }), 0, 0))).toBe(1)
    expect(motionOf(step())).toBe('complete')
  })

  it('quem leva: agente → principal da conversa; PO e sistema → PO da sala; usuário → ninguém', () => {
    expect(performerOf(step())).toBe('conv:k1')
    expect(performerOf(step({ actor: 'po' }))).toBe('po:r')
    expect(performerOf(step({ actor: 'system' }))).toBe('po:r')
    expect(performerOf(step({ actor: 'user' }))).toBeNull()
  })
})

describe('fila, ritmo e alcance (BoardChoreo)', () => {
  it('usuário desliza já com "Você"; autor desconhecido sem selo', () => {
    const c = new BoardChoreo(() => 0)
    expect(c.push([step({ actor: 'user' }), step({ actor: null, cardId: 'c2' })])).toEqual([
      { step: expect.objectContaining({ actor: 'user' }), seal: USER_SEAL, user: true },
      { step: expect.objectContaining({ actor: null }), seal: null, user: false }
    ])
  })

  it('agrupa por viagem: duas mudanças do mesmo agente, uma ida só (e corre)', () => {
    const c = new BoardChoreo(() => 0)
    c.push([step({ cardId: 'c2' }), step({ cardId: 'c3', toStatus: 'in_progress', at: '2026-10-04T00:00:01.000Z' })])
    const { trips, slides } = c.next(ctx())
    expect(slides).toEqual([])
    expect(trips).toHaveLength(1)
    expect(trips[0].steps.map((s) => s.cardId)).toEqual(['c2', 'c3'])
    expect(trips[0].lines).toEqual(['Concluí: Gerar o instalador', 'Comecei: Gerar o instalador'])
    expect(trips[0].errand.gait).toBe('run')
    // Ocupado na viagem: o que chegar depois espera a próxima ida.
    c.push([step({ cardId: 'c4' })])
    expect(c.next(ctx()).trips).toEqual([])
    c.end('conv:k1')
    expect(c.next(ctx()).trips[0].steps.map((s) => s.cardId)).toEqual(['c4'])
  })

  it('um passo só vai andando; mesmo cartão de autores diferentes: o segundo espera; cartões diferentes em paralelo', () => {
    const c = new BoardChoreo(() => 0)
    c.push([step(), step({ actor: 'system', toStatus: 'pending', text: 'o turno terminou sem concluir esta tarefa', at: '2026-10-04T00:00:05.000Z' }), step({ actor: 'po', cardId: 'outro', convId: 'k2' })])
    const first = c.next(ctx())
    expect(first.trips.map((t) => t.key).sort()).toEqual(['conv:k1', 'po:r'])
    expect(first.trips.find((t) => t.key === 'conv:k1')?.errand.gait).toBe('walk')
    expect(first.trips.find((t) => t.key === 'po:r')?.steps.map((s) => s.cardId)).toEqual(['outro'])
    c.end('po:r')
    expect(c.next(ctx()).trips).toEqual([]) // c1 está com o agente
    c.end('conv:k1')
    const second = c.next(ctx())
    expect(second.trips[0]).toMatchObject({ key: 'po:r', lines: ['Regra do fim do turno: o turno terminou sem concluir esta tarefa'] })
  })

  it('teto: 10 mudanças de uma vez → TRIP_CAP animadas, o resto direto e a fala-resumo', () => {
    const c = new BoardChoreo(() => 0)
    c.push(Array.from({ length: 10 }, (_, i) => step({ cardId: `c${i}`, kind: i < 7 ? 'moved' : 'new' })))
    const { trips, slides } = c.next(ctx({ walkS: () => 1 }))
    // O teto é TRIP_CAP, mas o invariante de LAG_MS manda: só o que cabe no prazo vai animado.
    const n = trips[0].steps.length
    expect(n).toBeGreaterThan(0)
    expect(n).toBe(TRIP_CAP)
    expect(slides).toHaveLength(10 - n)
    expect(slides.every((s) => s.seal === null)).toBe(true)
    expect(trips[0].summary).toBe(`+${10 - n} mudanças: ${7 - n} concluídas, 3 novas`)
  })

  it('no meio do trabalho: vai correndo, com os gestos curtos, e leva no máximo TRIP_CAP_BUSY (o resto vai direto)', () => {
    const c = new BoardChoreo(() => 0)
    c.push([step()])
    const one = c.next(ctx({ hurry: () => true })).trips[0]
    expect(one.errand.gait).toBe('run')
    const calm = stopsFor(step(), 0, 0)
    const sum = (st: typeof calm): number => st.reduce((n, x) => n + x.beats.reduce((m, b) => m + b.dur, 0), 0)
    expect(sum(one.errand.stops)).toBeLessThan(sum(calm))
    const c2 = new BoardChoreo(() => 0)
    c2.push(Array.from({ length: 5 }, (_, i) => step({ cardId: `c${i}` })))
    const { trips, slides } = c2.next(ctx({ walkS: () => 1, hurry: () => true }))
    expect(trips[0].steps).toHaveLength(TRIP_CAP_BUSY)
    expect(slides).toHaveLength(5 - TRIP_CAP_BUSY)
  })

  it('alcance: a ida que passaria de LAG_MS não vai — desliza com o selo', () => {
    let now = 0
    const c = new BoardChoreo(() => now)
    c.push([step()])
    now = LAG_MS - 2_000
    const { trips, slides } = c.next(ctx({ walkS: () => 9 }))
    expect(trips).toEqual([])
    expect(slides[0].seal).toBe('O agente concluiu: Gerar o instalador')
  })

  it('personagem indisponível (fora do escritório, PO desligado, permissão, apagão): selo em terceira pessoa', () => {
    const c = new BoardChoreo(() => 0)
    c.push([step(), step({ actor: 'system', cardId: 'c2', toStatus: 'pending', text: 'o turno terminou sem concluir esta tarefa' })])
    const { trips, slides } = c.next(ctx({ available: () => false }))
    expect(trips).toEqual([])
    expect(slides.map((s) => s.seal)).toEqual(['O agente concluiu: Gerar o instalador', 'Sistema — fim do turno: o turno terminou sem concluir esta tarefa'])
    expect(c.waiting).toBe(0)
  })
})

describe('PO presente sem ter rodado', () => {
  it('com o PO ligado e cartões no quadro da sala, ele aparece mesmo sem diagnóstico', () => {
    const f = feed({ conversations: [conv('a')] })
    expect(f.poDiagnostics).toEqual({})
    const room = roomIdFor(f.conversations[0].cwd)
    expect(deriveOfficeModel(f, NOW).characters.some((c) => c.role === 'po')).toBe(false)
    expect(deriveOfficeModel(f, NOW, new Set([room])).characters.find((c) => c.role === 'po')?.key).toBe(`po:${room}`)
    expect(deriveOfficeModel({ ...f, observersOn: { ...f.observersOn, po: false } }, NOW, new Set([room])).characters.some((c) => c.role === 'po')).toBe(false)
  })
})
