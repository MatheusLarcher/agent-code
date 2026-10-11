import { describe, expect, it } from 'vitest'
import type { ScrumChangedMsg, ScrumDecisao } from '@shared/scrumPanel'
import { stepBrain } from '../brain'
import { createBrain, type Brain, type BrainWorld } from '../brainBody'
import { DESK, newErrand, visitSpotOf, type BoardSpot, type BoardWorld } from '../brainBoard'
import type { Quip } from '../quips'
import { HOLD_GRACE_MS, sayText, ScrumVisits, visitOf, type ScrumVisitApi, type ScrumVisitReq } from './scrumVisit'

const ROOM = 'c:/proj/a'
const OTHER = 'c:/proj/b'

function d(over: Partial<ScrumDecisao> = {}): ScrumDecisao {
  return {
    id: 'x',
    at: '2026-10-11T12:00:00.000Z',
    tipo: 'cobrou',
    convId: 'k1',
    conversationTitle: 'Checkout',
    envioId: 'e1',
    entregaId: 'ent',
    etapaId: 'visual',
    etapaN: 4,
    projectCwd: 'C:\\proj\\a',
    marco: 150,
    veredito: 'desvio',
    tipoDesvio: 'laco-de-teste',
    motivo: 'rodou o mesmo teste',
    cobranca: 'A etapa visual passou de 150% do prazo. O que falta para fechar?',
    tempoAtivoMs: 30 * 60_000,
    prazoMin: 20,
    declaradoMin: null,
    decorridoMs: null,
    rota: 'm',
    durationMs: 1,
    ...over
  }
}

/** Sem obstáculos: caminho em linha reta. */
function world(): BrainWorld & BoardWorld {
  return {
    t: 0,
    rng: () => 0.5,
    sleepAfter: 1e9,
    camX: 0,
    camZ: 10,
    plan(b) {
      b.path[0] = b.goal.x
      b.path[1] = b.goal.z
      return 1
    },
    claim: () => null,
    release: () => {},
    queueSpot: () => null,
    wander: () => false,
    pairUp: () => false,
    partner: () => null,
    doorOut: () => null,
    frontSpot: () => ({ x: 0, z: 8, yaw: Math.PI }),
    party: () => null,
    boardSpot(_b, col, out: BoardSpot) {
      Object.assign(out, { x: col, z: -6.5, yaw: 0, lx: col, ly: 1.4, lz: -7 })
      return true
    }
  }
}

function fakeApi(stopped: ScrumVisitReq[] = []): ScrumVisitApi & { emit(d: ScrumDecisao): void } {
  let cb: ((m: ScrumChangedMsg) => void) | null = null
  return {
    onChanged: (fn) => {
      cb = fn
      return () => (cb = null)
    },
    stopped: async () => stopped,
    emit: (x) => cb?.({ decisao: x })
  }
}

function setup(opts: { stopped?: ScrumVisitReq[]; agentRoom?: string } = {}) {
  const sm = createBrain({ key: `scrum:${ROOM}`, role: 'fixed', style: 'board', roomId: 'office', projectId: ROOM, home: { x: 1.45, z: -6.4, yaw: 0 } })
  const agent = createBrain({ key: 'conv:k1', role: 'desk', roomId: 'office', projectId: opts.agentRoom ?? ROOM, home: { x: -4.9, z: 0.05, yaw: 0 }, desk: { x: -4.9, z: -0.9, yaw: 0, out: 1 } })
  agent.phase = 'working'
  const brains = new Map<string, Brain>([
    [sm.key, sm],
    [agent.key, agent]
  ])
  const said: Array<[string, Quip | null]> = []
  const api = fakeApi(opts.stopped)
  let now = 0
  const visits = new ScrumVisits(
    { brain: (k) => brains.get(k), brains: () => brains.values(), live: () => true, say: (k, q) => said.push([k, q]) },
    api,
    () => now
  )
  const w = world()
  const step = (seconds: number, each?: () => void): void => {
    for (let t = 0; t < seconds; t += 0.05) {
      w.t += 0.05
      now += 50
      stepBrain(agent, 0.05, w)
      stepBrain(sm, 0.05, w)
      visits.tick(now)
      each?.()
    }
  }
  // O agente senta na mesa antes de tudo.
  step(12)
  return { sm, agent, brains, said, api, visits, step, now: () => now }
}

const near = (b: Brain, s: BoardSpot): boolean => Math.hypot(b.x - s.x, b.z - s.z) < 0.3

describe('visitOf — o que leva o Scrum Master à mesa', () => {
  it('só a cobrança a partir de 150% e o corte; o resto não', () => {
    expect(visitOf(d())).toMatchObject({ convId: 'k1', hold: false })
    expect(visitOf(d({ tipo: 'cobrou', marco: 200 }))?.hold).toBe(false)
    expect(visitOf(d({ tipo: 'falha', marco: 300 }))).not.toBeNull()
    expect(visitOf(d({ tipo: 'falha', cobranca: null }))).toBeNull()
    expect(visitOf(d({ tipo: 'cobrou', marco: 'travado' }))).toBeNull()
    expect(visitOf(d({ tipo: 'cobrou', marco: null }))).toBeNull()
    for (const tipo of ['entregue', 'deixou-seguir', 'avisou', 'interrompeu', 'declarou', 'contestado', 'resposta', 'aprovou', 'recusou'] as const) {
      expect(visitOf(d({ tipo }))).toBeNull()
    }
    expect(visitOf(d({ tipo: 'parou', marco: 300, motivo: 'Scrum Master: laço de teste' }))).toEqual({ convId: 'k1', text: 'Parei o envio: laço de teste', hold: true })
  })

  it('o balão leva o começo da cobrança', () => {
    expect(sayText('A etapa visual passou de 150% do prazo. O que falta?')).toBe('A etapa visual passou de 150% do prazo.')
    const long = sayText('x'.repeat(200))
    expect(long.length).toBe(90)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('ScrumVisits — a ida à mesa do agente', () => {
  it('cobrança: o SM vai à mesa (só a parada DESK), fala o começo da cobrança e volta ao lugar', () => {
    const s = setup()
    const at: BoardSpot = { x: 0, z: 0, yaw: 0, lx: 0, ly: 0, lz: 0 }
    expect(visitSpotOf(s.agent, at)).toBe(true)
    s.api.emit(d())
    s.visits.tick(s.now())
    expect(s.visits.visiting).toEqual([{ key: s.sm.key, target: 'conv:k1', hold: false, state: 'go' }])
    expect(s.sm.errand?.stops.map((x) => x.col)).toEqual([DESK])
    let talked = false
    s.step(30, () => {
      if (s.sm.action === 'talk' && near(s.sm, at)) talked = true
    })
    expect(talked).toBe(true)
    const spoken = s.said.find(([k, q]) => k === s.sm.key && q)
    expect(spoken?.[1]).toMatchObject({ text: 'A etapa visual passou de 150% do prazo.', convId: 'k1' })
    expect(s.said.at(-1)).toEqual([s.sm.key, null])
    expect(s.visits.visiting).toEqual([])
    expect(s.sm.errand).toBeNull()
    s.step(20)
    expect(near(s.sm, { ...at, x: s.sm.home.x, z: s.sm.home.z })).toBe(true)
    s.visits.dispose()
  })

  it('só na sala: agente de outro projeto (sem SM) não recebe visita', () => {
    const s = setup({ agentRoom: OTHER })
    s.api.emit(d())
    s.step(20)
    expect(s.visits.visiting).toEqual([])
    expect(s.sm.errand).toBeNull()
    expect(near(s.sm, { x: s.sm.home.x, z: s.sm.home.z, yaw: 0, lx: 0, ly: 0, lz: 0 })).toBe(true)
    s.visits.dispose()
  })

  it('aviso, travado e linhas que não são cobrança não tiram o SM do lugar', () => {
    const s = setup()
    s.api.emit(d({ tipo: 'avisou', marco: 200 }))
    s.api.emit(d({ tipo: 'cobrou', marco: 'travado' }))
    s.api.emit(d({ tipo: 'resposta' }))
    s.step(5)
    expect(s.visits.visiting).toEqual([])
    expect(s.sm.errand).toBeNull()
    s.visits.dispose()
  })

  it('lugar ocupado (outro personagem indo à mesa) ou agente fora da mesa: pula', () => {
    const s = setup()
    const po = createBrain({ key: `po:${ROOM}`, role: 'fixed', style: 'board', roomId: 'office', projectId: ROOM, home: { x: -2, z: -6.4, yaw: 0 } })
    po.errand = newErrand([{ col: DESK, beats: [{ action: 'talk', dur: 9, prop: null }], step: -1, fired: false, visit: 'conv:k1', at: { x: 0, z: 0, yaw: 0, lx: 0, ly: 0, lz: 0 } }], 'walk')
    s.brains.set(po.key, po)
    s.api.emit(d())
    s.visits.tick(s.now())
    expect(s.visits.visiting).toEqual([])
    s.brains.delete(po.key)
    s.agent.outside = true
    s.api.emit(d())
    s.visits.tick(s.now())
    expect(s.visits.visiting).toEqual([])
    expect(s.sm.errand).toBeNull()
    s.visits.dispose()
  })

  it('corte: fica na mesa do parado até a retomada (o agente volta a trabalhar), depois volta', () => {
    const s = setup()
    s.agent.phase = 'idle'
    s.api.emit(d({ tipo: 'parou', marco: 300, motivo: 'laço de teste' }))
    s.step(40)
    expect(s.visits.visiting).toEqual([{ key: s.sm.key, target: 'conv:k1', hold: true, state: 'act' }])
    expect(s.said.find(([, q]) => q)?.[1]?.text).toBe('Parei o envio: laço de teste')
    // A retomada: o agente trabalha de novo.
    s.agent.phase = 'working'
    s.step(HOLD_GRACE_MS / 1000 + 25)
    expect(s.visits.visiting).toEqual([])
    expect(s.sm.errand).toBeNull()
    expect(near(s.sm, { x: s.sm.home.x, z: s.sm.home.z, yaw: 0, lx: 0, ly: 0, lz: 0 })).toBe(true)
    s.visits.dispose()
  })

  it('ao abrir o app, o envio ainda parado leva o SM de volta à mesa', async () => {
    const s = setup({ stopped: [{ convId: 'k1', text: 'Parei o envio: x', hold: true }] })
    s.agent.phase = 'idle'
    await new Promise((r) => setTimeout(r, 0))
    s.step(30)
    expect(s.visits.visiting.map((v) => [v.target, v.hold])).toEqual([['conv:k1', true]])
    s.visits.dispose()
    expect(s.sm.errand).toBeNull()
  })
})
