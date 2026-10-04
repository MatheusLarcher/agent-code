import { describe, expect, it } from 'vitest'
import { createBrain, move, type Brain, type BrainWorld } from '../brainBody'
import { runErrand, newErrand, type BoardSpot, type BoardWorld } from '../brainBoard'
import { stepBrain } from '../brain'
import type { BoardStep } from './boardModel'
import { BoardStage, SAY_MIN_MS, VISIT_HOLD_MS, type StageHost } from './boardStage'
import { LAG_MS, stopsFor } from './boardChoreo'

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
  ...o
})

/** Um mundo de uma sala só: o quadro no fundo (z = 0), três colunas, caminho em linha reta. */
function world(taken: Set<number> = new Set()): BrainWorld & BoardWorld {
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
      Object.assign(out, { x: col, z: 1, yaw: 0, lx: col, ly: 1.4, lz: 0 })
      if (!taken.has(col)) return true
      out.z = 1.7
      return false
    }
  }
}

function agent(): Brain {
  const b = createBrain({ key: 'conv:k1', role: 'desk', roomId: 'office', projectId: 'r', home: { x: 0, z: 6, yaw: 0 }, desk: { x: 0, z: 6, dir: 1, out: 1 } })
  b.phase = 'working'
  return b
}

function run(b: Brain, w: BrainWorld & BoardWorld, seconds: number): void {
  for (let t = 0; t < seconds && b.errand && b.errand.state !== 'done' && b.errand.state !== 'aborted'; t += 0.05) {
    w.t += 0.05
    stepBrain(b, 0.05, w)
  }
}

describe('a ida ao quadro no cérebro (brainBoard)', () => {
  it('o principal levanta da mesa, leva o papel da coluna 0 para Concluído, carimba e volta a sentar no modo work', () => {
    const b = agent()
    const w = world()
    stepBrain(b, 0.05, w)
    expect(b.mode).toBe('work')
    b.errand = newErrand(stopsFor(step(), 0, 0), 'walk')
    const actions = new Set<string>()
    let carried = false
    for (let t = 0; t < 30 && b.errand.state !== 'done'; t += 0.05) {
      w.t += 0.05
      stepBrain(b, 0.05, w)
      actions.add(b.action)
      if (b.prop === 'note' && b.errand.idx === 1 && b.errand.state === 'go') carried = true
    }
    expect(b.errand.state).toBe('done')
    expect(b.errand.stops[1].fired).toBe(true)
    expect(carried).toBe(true)
    expect([...actions]).toEqual(expect.arrayContaining(['unpin', 'stick', 'stamp']))
    b.errand = null
    for (let t = 0; t < 15; t += 0.05) stepBrain(b, 0.05, w)
    expect(b.sit).toBe(1)
    expect(b.prop).toBeNull()
  })

  it('permissão pendente no meio: aborta (o papel desliza sozinho)', () => {
    const b = agent()
    const w = world()
    b.errand = newErrand(stopsFor(step(), 0, 0), 'walk')
    run(b, w, 1)
    b.phase = 'waiting-permission'
    run(b, w, 1)
    expect(b.errand.state).toBe('aborted')
  })

  it('coluna ocupada: espera ao lado até liberar', () => {
    const taken = new Set([2])
    const b = createBrain({ key: 'po:r', role: 'fixed', style: 'board', roomId: 'office', projectId: 'r', home: { x: 1, z: 2, yaw: 0 } })
    const w = world(taken)
    b.errand = newErrand(stopsFor(step({ actor: 'po' }), null, 0), 'walk')
    run(b, w, 6)
    expect(b.errand.state).toBe('wait')
    expect(b.action).toBe('wait')
    taken.clear()
    run(b, w, 10)
    expect(b.errand.state).toBe('done')
  })

  it('runErrand sem tarefa não faz nada; move continua independente', () => {
    const b = agent()
    runErrand(b, 0.05, world())
    move(b, 0.05, world())
    expect(b.errand).toBeNull()
  })
})

function host(o: Partial<StageHost> & { brains?: Map<string, Brain> } = {}): StageHost & { applied: string[]; said: Array<[string, string | null]>; sealed: Array<[string, string, boolean]> } {
  const applied: string[] = []
  const said: Array<[string, string | null]> = []
  const sealed: Array<[string, string, boolean]> = []
  const brains = o.brains ?? new Map()
  return {
    applied,
    said,
    sealed,
    brain: (k) => brains.get(k),
    boardDistance: () => 3,
    live: () => true,
    dark: () => false,
    fromColumn: () => 0,
    differs: () => true,
    apply: (_r, id) => applied.push(id),
    say: (k, t) => said.push([k, t]),
    seal: (_r, id, t, u) => sealed.push([id, t, u]),
    draggedHere: () => false,
    wall: () => 'r',
    visit: () => true,
    ...o
  }
}

describe('o palco (boardStage): fila → personagens, parede, falas, selos', () => {
  it('o agente leva o papel: só aplica quando prende, fala "Concluí: …" e solta a fala depois de SAY_MIN_MS', () => {
    let now = 0
    const b = agent()
    const w = world()
    const h = host({ brains: new Map([['conv:k1', b]]) })
    const stage = new BoardStage(h, () => now)
    stage.push([step()])
    expect(b.errand).not.toBeNull()
    expect(h.applied).toEqual([])
    for (let i = 0; i < 400 && b.errand; i++) {
      w.t += 0.05
      stepBrain(b, 0.05, w)
      now += 50
      stage.tick(now)
    }
    expect(b.errand).toBeNull()
    expect(h.applied).toEqual(['c1'])
    expect(h.said[0]).toEqual(['conv:k1', 'Concluí: Gerar o instalador'])
    expect(stage.cardOf('conv:k1')).toBe('c1')
    now += SAY_MIN_MS
    stage.tick(now)
    expect(h.said.at(-1)).toEqual(['conv:k1', null])
  })

  it('apagão (sala no escuro): ninguém sai da festa — desliza com o selo', () => {
    const b = agent()
    const h = host({ brains: new Map([['conv:k1', b]]), dark: () => true })
    new BoardStage(h, () => 0).push([step()])
    expect(b.errand).toBeNull()
    expect(h.applied).toEqual(['c1'])
    expect(h.sealed).toEqual([['c1', 'O agente concluiu: Gerar o instalador', false]])
  })

  it('conversa fora do escritório / PO desligado: sem personagem, desliza com o selo', () => {
    const h = host()
    new BoardStage(h, () => 0).push([step(), step({ actor: 'po', cardId: 'c2', text: 'falta testar' })])
    expect(h.applied).toEqual(['c1', 'c2'])
    expect(h.sealed.map((x) => x[1])).toEqual(['O agente concluiu: Gerar o instalador', 'PO: falta testar'])
  })

  it('usuário no Quadro do app: desliza com "Você"; arrasto no 3D (papel já no lugar): nada reanima', () => {
    const h = host()
    const stage = new BoardStage(h, () => 0)
    stage.push([step({ actor: 'user' })])
    expect(h.sealed).toEqual([['c1', 'Você', true]])
    const h2 = host({ differs: () => false })
    new BoardStage(h2, () => 0).push([step({ actor: 'user' })])
    expect(h2.applied).toEqual(['c1'])
    expect(h2.sealed).toEqual([])
  })

  it('projeto fora da parede: espera, o quadro troca para ele durante a coreografia, segura VISIT_HOLD_MS e volta', () => {
    let now = 0
    let wall = 'outro'
    const visits: Array<string | null> = []
    const b = agent()
    const w = world()
    const h = host({
      brains: new Map([['conv:k1', b]]),
      wall: () => wall,
      visit: (id) => {
        visits.push(id)
        wall = id ?? 'outro'
        return true
      }
    })
    const stage = new BoardStage(h, () => now)
    stage.push([step()])
    // Trocou a parede para o projeto do passo e a viagem começou.
    expect(visits).toEqual(['r'])
    expect(b.errand).not.toBeNull()
    for (let i = 0; i < 400 && b.errand; i++) {
      w.t += 0.05
      stepBrain(b, 0.05, w)
      now += 50
      stage.tick(now)
    }
    expect(h.applied).toEqual(['c1'])
    stage.tick(now)
    expect(visits).toEqual(['r'])
    now += VISIT_HOLD_MS + 50
    stage.tick(now)
    expect(visits).toEqual(['r', null])
    expect(wall).toBe('outro')
  })

  it('visita recusada (o filtro) ou estacionado demais: o passo vai direto ao espelho', () => {
    let now = 0
    const h = host({ brains: new Map([['conv:k1', agent()]]), wall: () => 'outro', visit: () => false })
    const stage = new BoardStage(h, () => now)
    stage.push([step()])
    expect(h.applied).toEqual(['c1'])
    // Palco ocupado com a viagem do projeto da parede: o passo do outro espera; passou de LAG_MS, vai direto.
    const other = createBrain({ key: 'conv:k2', role: 'desk', roomId: 'office', projectId: 'outro', home: { x: 0, z: 6, yaw: 0 }, desk: { x: 0, z: 6, dir: 1, out: 1 } })
    other.phase = 'working'
    const h2 = host({ brains: new Map([['conv:k2', other]]), wall: () => 'outro' })
    const busy = new BoardStage(h2, () => now)
    busy.push([step({ roomId: 'outro', convId: 'k2', cardId: 'c0' })])
    expect(other.errand).not.toBeNull()
    busy.push([step({ cardId: 'c2' })])
    expect(h2.applied).toEqual([])
    now = LAG_MS + 10
    busy.tick(now)
    expect(h2.applied).toContain('c2')
  })

  it('aba escondida: tudo direto, sem maratona; viagem em curso é abortada', () => {
    let live = true
    const b = agent()
    const h = host({ brains: new Map([['conv:k1', b]]), live: () => live })
    const stage = new BoardStage(h, () => 0)
    stage.push([step()])
    expect(b.errand).not.toBeNull()
    live = false
    stage.tick(0)
    expect(b.errand).toBeNull()
    expect(h.applied).toEqual(['c1'])
    stage.push([step({ cardId: 'c9' })])
    expect(h.applied).toEqual(['c1', 'c9'])
  })
})
