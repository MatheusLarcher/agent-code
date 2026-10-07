/**
 * Regressão "o agente foi dormir trabalhando": com TAREFA ATIVA (turno, permissão, recuperação agendada ou
 * mensagem na fila) o principal fica na mesa da ilha do projeto — as três hipóteses do cochilo reproduzidas
 * (fase 'error' acima de 'working', ilha cheia de parados → sofá, `busyIds` sem a conversa) e as saídas
 * da mesa que deixaram de existir (permissão na frente do escritório, fila do café com tarefa).
 */
import { describe, expect, it } from 'vitest'
import type { OfficeFeed } from '../office/adapter/feed'
import { deriveOfficeModel, type OfficeCharacterModel } from '../office/adapter/model'
import { conv, feed, NOW, track } from '../office/adapter/testFeed'
import { SLEEP_AFTER_SEC } from '../office/behavior/leisure'
import type { TurnRecovery, UIMessage } from '../types'
import { brainStatus, setStatus, type Brain, type BrainStatus, type Mode } from './brain'
import { Crowd } from './crowd'
import { snapshotOf } from './events'
import { seatOf } from './furniture'
import { layoutOffice, type Office3DLayout } from './layout'
import { STATIONS } from './officePlan'
import type { Reaction } from './poses'

const CAM = { x: 6, z: 30 }
const HOUR = 60 * 60 * 1000

function principal(id: string, extra: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel {
  return {
    key: `conv:${id}`, convId: id, roomId: 'r1', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
    seed: `conv:${id}`, active: false, activity: null, bubble: null, label: '', ...extra
  }
}

const status = (phase: BrainStatus['phase'], extra: Partial<BrainStatus> = {}): BrainStatus => ({
  phase, tool: null, contextPct: null, usageOut: false, stalled: false, idleSince: null, ...extra
})

function office(n: number) {
  const chars = Array.from({ length: n }, (_, i) => principal(`p${i}`))
  const layout = layoutOffice({ rooms: [{ id: 'r1', projectKey: 'r1', name: 'r1', icon: null, principals: n }], characters: chars })
  const crowd = new Crowd(7)
  crowd.syncRooms(layout.rooms)
  const rooms = new Map(layout.rooms.map((r) => [r.id, r] as const))
  return { crowd, brains: layout.characters.map((c) => crowd.upsert(c, false, rooms)), room: layout.rooms[0] }
}

function run(crowd: Crowd, seconds: number, each?: () => void, dt = 0.1): void {
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    crowd.step(dt, crowd.t + dt, CAM.x, CAM.z)
    each?.()
  }
}

/** Os modos por que o cérebro passou (a cada passo). */
const modesOf = (b: Brain, out: Set<Mode>): (() => void) => () => void out.add(b.mode)

// ── hipótese 2: ilha cheia de parados → o novo ia para o sofá ──────────────────────────────────────

describe('mesa por prioridade: quem tem tarefa ativa senta na ilha do projeto', () => {
  const idle = Array.from({ length: 6 }, (_, i) => principal(`p${i}`, { activityAt: NOW - (10 - i) * HOUR }))
  const rooms = [{ id: 'r1', projectKey: 'r1', name: 'r1', icon: null, principals: 7 }]
  const deskOf = (l: Office3DLayout, key: string): number | null => l.characters.find((c) => c.key === key)?.deskIndex ?? null
  const spotOf = (l: Office3DLayout, key: string): string | undefined => l.characters.find((c) => c.key === key)?.spot

  it('6 conversas paradas + 1 que começa a trabalhar: a nova senta numa mesa e a parada mais antiga cede (vai para o lounge)', () => {
    const one = layoutOffice({ rooms, characters: idle })
    expect(idle.every((c) => deskOf(one, c.key) !== null)).toBe(true)
    // Antes da correção: ilha cheia → o novo trabalhava no sofá do lounge (igual a quem cochila).
    const two = layoutOffice({ rooms, characters: [...idle, principal('novo', { active: true, task: true, activityAt: NOW })] }, one)
    expect(spotOf(two, 'conv:novo')).toBe('desk')
    expect(STATIONS[deskOf(two, 'conv:novo')!].island).toBe(STATIONS[deskOf(one, 'conv:p0')!].island)
    // Quem cedeu foi o parado com a atividade mais antiga (p0); os outros não se mexem.
    expect(deskOf(two, 'conv:novo')).toBe(deskOf(one, 'conv:p0'))
    expect(spotOf(two, 'conv:p0')).toBe('lounge')
    for (const c of idle.slice(1)) expect(deskOf(two, c.key)).toBe(deskOf(one, c.key))
  })

  it('sem tarefa ninguém cede (ninguém pula de lugar à toa); só o 7º trabalhando ao mesmo tempo fica sem mesa', () => {
    const one = layoutOffice({ rooms, characters: idle })
    const calm = layoutOffice({ rooms, characters: [...idle, principal('novo', { activityAt: NOW })] }, one)
    expect(spotOf(calm, 'conv:novo')).toBe('lounge')
    for (const c of idle) expect(deskOf(calm, c.key)).toBe(deskOf(one, c.key))
    // Os 6 trabalhando: o 7º (também trabalhando) não tira ninguém.
    const busy = idle.map((c) => ({ ...c, active: true, task: true }))
    const full = layoutOffice({ rooms, characters: busy })
    const seventh = layoutOffice({ rooms, characters: [...busy, principal('novo', { active: true, task: true })] }, full)
    expect(spotOf(seventh, 'conv:novo')).toBe('lounge')
    for (const c of busy) expect(deskOf(seventh, c.key)).toBe(deskOf(full, c.key))
  })

  it('tarefa sem turno rodando (recuperação agendada) também ganha mesa; quem cedeu volta a uma mesa quando vagar', () => {
    const one = layoutOffice({ rooms, characters: idle })
    const waiting = principal('novo', { task: true, activityAt: NOW })
    const two = layoutOffice({ rooms, characters: [...idle, waiting] }, one)
    expect(spotOf(two, 'conv:novo')).toBe('desk')
    // p3 sai do escritório: a mesa dele vai para p0 (o que tinha cedido).
    const three = layoutOffice({ rooms, characters: [...idle.filter((c) => c.key !== 'conv:p3'), waiting] }, two)
    expect(deskOf(three, 'conv:p0')).toBe(deskOf(two, 'conv:p3'))
    expect(deskOf(three, 'conv:novo')).toBe(deskOf(two, 'conv:novo'))
  })
})

// ── hipóteses 1 e 3 na camada pura (events/model) ─────────────────────────────────────────────────

describe('tarefa ativa no retrato (events.ts / model.hasActiveTask)', () => {
  const u = (id: string): UIMessage => ({ kind: 'user', id, text: 'faz o deploy' })
  const err = (id: string, text: string, usageExhausted = false): UIMessage => ({ kind: 'error', id, text, ...(usageExhausted ? { usageExhausted } : {}) })
  const recovery = (over: Partial<TurnRecovery> = {}): TurnRecovery => ({ id: 'r', reason: 'transient', scheduledAt: NOW + 30_000, attempt: 1, maxAttempts: 5, errorText: 'x', messageId: 'u1', ...over })
  const world = (messages: UIMessage[], over: Partial<OfficeFeed> = {}, rec?: TurnRecovery): OfficeFeed =>
    feed({ conversations: [conv('a', { messages, updatedAt: NOW - 1_000, ...(rec ? { recovery: rec } : {}) })], activeId: 'a', ...over })
  const main = (f: OfficeFeed) => {
    const model = deriveOfficeModel(f, NOW)
    return { status: snapshotOf(f, model, NOW).agents.get('conv:a')!, model: model.characters.find((c) => c.key === 'conv:a')! }
  }

  it('hipótese 1: erro no fim do turno com a recuperação agendada — a fase é "error" (o App mantém a conversa ocupada), mas a tarefa continua', () => {
    const f = world([u('u1'), err('e1', 'API Error: 529 Overloaded')], { busyIds: new Set(['a']) }, recovery())
    const { status: s, model } = main(f)
    expect(s.phase).toBe('error')
    expect(s.task).toBe(true)
    expect(model.task).toBe(true)
    // O balão de erro aparece mesmo com a conversa ocupada esperando a retomada.
    expect(model.bubble).toBe('erro')
    // Limite de uso esperando a volta: idem (sem busyIds, como depois de reiniciar o app).
    const limit = main(world([u('u1'), err('e1', 'Claude AI usage limit reached', true)], {}, recovery({ reason: 'limit', scheduledAt: NOW + HOUR })))
    expect([limit.status.phase, limit.status.task, limit.status.usageExhausted !== null]).toEqual(['error', true, true])
    // Recuperação encerrada (scheduledAt 0: tentativas esgotadas): não há mais tarefa.
    expect(main(world([u('u1'), err('e1', 'boom')], {}, recovery({ scheduledAt: 0 }))).status.task).toBe(false)
  })

  it('hipótese 3: prompt esperando a vez fora do turno (fila do chat/quadro) — sem `queuedIds` a conversa parece parada; com ele, é tarefa', () => {
    // A implementação recém-criada com o 1º prompt esperando na fila do quadro: nada em busyIds.
    const waiting = world([])
    expect(main(waiting).status.task).toBe(false)
    const queued = main(world([], { queuedIds: new Set(['a']) }))
    expect(queued.status.task).toBe(true)
    expect(queued.model.task).toBe(true)
    expect(queued.model.bubble).toBe('ampulheta')
  })

  it('permissão pendente e turno rodando são tarefa; conversa parada não', () => {
    expect(main(world([u('u1')], { busyIds: new Set(['a']) })).status.task).toBe(true)
    expect(main(world([u('u1')], { permissions: { a: { id: 'p', toolName: 'Bash', input: { command: 'rm x' } } } })).status.task).toBe(true)
    expect(main(world([u('u1')])).status.task).toBe(false)
  })
})

// ── subagentes em segundo plano: cada um no próprio PC ───────────────────────────────────────────

describe('subagente rodando ganha mesa própria com PC na ilha do projeto', () => {
  const bg = (n: number, over: Partial<OfficeFeed> = {}): OfficeFeed =>
    feed({
      conversations: [conv('a', { messages: [], updatedAt: NOW - 1_000 })],
      activeId: 'a',
      // O turno do principal já parou: só os subagentes em segundo plano seguem.
      tracks: { a: Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, track(`t${i}`, { subagentType: 'general-purpose', label: `t${i}` })])) },
      ...over
    })

  it('principal + 3 subagentes em segundo plano: 4 mesas com PCs distintos, cada uma com a trilha certa; o principal espera sentado', () => {
    const f = bg(3)
    const model = deriveOfficeModel(f, NOW)
    const l = layoutOffice(model)
    const keys = ['conv:a', 'track:t0', 'track:t1', 'track:t2']
    const chars = keys.map((k) => l.characters.find((c) => c.key === k)!)
    expect(chars.map((c) => c.spot)).toEqual(['desk', 'desk', 'desk', 'desk'])
    const desks = chars.map((c) => c.deskIndex!)
    expect(new Set(desks).size).toBe(4)
    expect(new Set(desks.map((d) => STATIONS[d].island)).size).toBe(1)
    // O PC de cada mesa é do dono dela: o monitor e o clique (charKey → modelo com trackId) mostram aquela trilha.
    for (const c of chars) {
      expect(c.screenDesk).toEqual({ roomId: c.roomId, index: c.deskIndex })
      expect(l.rooms[0].desks[c.deskIndex!].ownerKey).toBe(c.key)
    }
    expect(chars.slice(1).map((c) => c.model.trackId)).toEqual(['t0', 't1', 't2'])
    // O principal, sem turno rodando, tem tarefa: espera os subagentes.
    const s = snapshotOf(f, model, NOW).agents.get('conv:a')!
    expect([s.phase, s.task]).toEqual(['idle', true])
    expect(brainStatus(s, 0, NOW).task).toBe(true)
  })

  it('o principal esperando os subagentes fica sentado em modo work, nunca dorme; a trilha acabou, sai e a mesa volta', () => {
    const f = bg(1)
    const model = deriveOfficeModel(f, NOW)
    const layout = layoutOffice(model)
    const crowd = new Crowd(3)
    crowd.syncRooms(layout.rooms)
    const rooms = new Map(layout.rooms.map((r) => [r.id, r] as const))
    const [main, sub] = layout.characters.map((c) => crowd.upsert(c, false, rooms))
    const snap = snapshotOf(f, model, NOW)
    setStatus(main, { ...brainStatus(snap.agents.get('conv:a')!, 0, NOW), idleSince: -SLEEP_AFTER_SEC - 600 }, 0)
    setStatus(sub, brainStatus(snap.agents.get('track:t0')!, 0, NOW), 0)
    const modes = new Set<Mode>()
    run(crowd, 40, modesOf(main, modes))
    expect([...modes]).toEqual(['work'])
    expect([main.sit, main.seat]).toEqual([1, 'chair'])
    // O subagente senta na mesa dele (não ao lado do pai).
    expect([sub.mode, sub.sit, sub.seat]).toEqual(['work', 1, 'chair'])
    expect(sub.desk).not.toBeNull()
    expect(Math.hypot(sub.desk!.x - main.desk!.x, sub.desk!.z - main.desk!.z)).toBeGreaterThan(0.5)
    // Fim da trilha: sai do modelo e a mesa vaga.
    const done = bg(1, { tracks: { a: { t0: track('t0', { subagentType: 'general-purpose', status: 'done', endedAt: NOW }) } } })
    const after = layoutOffice(deriveOfficeModel(done, NOW), layout)
    expect(after.characters.some((c) => c.key === 'track:t0')).toBe(false)
    expect(after.rooms[0].desks.filter((d) => d.ownerKey !== null).map((d) => d.ownerKey)).toEqual(['conv:a'])
  })

  it('ilha cheia de quem tem tarefa: o subagente fica ao lado do pai e não tira a mesa de ninguém; tira a de um parado', () => {
    const rooms = [{ id: 'r1', projectKey: 'r1', name: 'r1', icon: null, principals: 6 }]
    const guest: OfficeCharacterModel = { ...principal('p0'), key: 'track:x', role: 'subagente', trackId: 'x', placement: { kind: 'beside', parentKey: 'conv:p0' }, active: true, task: true }
    const busy = Array.from({ length: 6 }, (_, i) => principal(`p${i}`, { active: true, task: true }))
    const full = layoutOffice({ rooms, characters: busy })
    const l = layoutOffice({ rooms, characters: [...busy, guest] }, full)
    expect(l.characters.find((c) => c.key === 'track:x')!.spot).toBe('beside')
    for (const c of busy) expect(l.characters.find((x) => x.key === c.key)!.deskIndex).toBe(full.characters.find((x) => x.key === c.key)!.deskIndex)
    // Com um parado (o mais antigo) na ilha, o subagente rodando fica com a mesa dele.
    const mixed = busy.map((c, i) => (i === 5 ? { ...c, active: false, task: false, activityAt: NOW - HOUR } : c))
    const one = layoutOffice({ rooms, characters: mixed })
    const two = layoutOffice({ rooms, characters: [...mixed, guest] }, one)
    expect(two.characters.find((c) => c.key === 'track:x')!.deskIndex).toBe(one.characters.find((c) => c.key === 'conv:p5')!.deskIndex)
    // Principal com tarefa chegando sem mesa: tira a do subagente (que volta para o lado do pai).
    const three = layoutOffice({ rooms, characters: [...mixed.slice(0, 5), { ...mixed[5], active: true, task: true }, guest] }, two)
    expect(three.characters.find((c) => c.key === 'conv:p5')!.spot).toBe('desk')
    expect(three.characters.find((c) => c.key === 'track:x')!.spot).toBe('beside')
  })
})

// ── o cérebro: com tarefa nunca free/sleep/archive; saídas só quadro/reunião ───────────────────────

describe('cérebro com tarefa ativa fica na mesa', () => {
  it('hipótese 1: erro + recuperação agendada → modo work, sentado esperando (tamborila e olha o relógio), nunca dorme', () => {
    const { crowd, brains, room } = office(1)
    const b = brains[0]
    // Parado há muito mais que o cochilo, com a fase de erro: antes ia para free → sleep.
    setStatus(b, status('error', { task: true, idleSince: -SLEEP_AFTER_SEC - 600 }), 0)
    const modes = new Set<Mode>()
    let watches = 0
    let last: Reaction | null = null
    run(crowd, 60, () => {
      modes.add(b.mode)
      if (b.reaction === 'watch' && last !== 'watch') watches++
      last = b.reaction
    })
    expect([...modes]).toEqual(['work'])
    const seat = seatOf(room.desks.find((d) => d.ownerKey === b.key)!)
    expect([b.sit, b.seat, b.zzz]).toEqual([1, 'chair', false])
    expect(Math.hypot(b.x - seat.x, b.z - seat.z)).toBeLessThan(0.02)
    expect(b.action).toBe('drum')
    expect(watches).toBeGreaterThanOrEqual(2)
  })

  it('com tarefa o cérebro nunca entra em free/sleep/archive/queue, qualquer que seja a fase', () => {
    for (const phase of ['idle', 'done', 'error'] as const) {
      const { crowd, brains } = office(1)
      const b = brains[0]
      b.shelfTrip = { use: 'read', until: Infinity }
      setStatus(b, status(phase, { task: true, idleSince: -SLEEP_AFTER_SEC - 600 }), 0)
      const modes = new Set<Mode>()
      run(crowd, 30, modesOf(b, modes))
      expect([...modes], phase).toEqual(['work'])
      expect(b.shelfTrip, phase).toBeNull()
    }
    // A tarefa acabou: aí sim pode cochilar.
    const { crowd, brains } = office(1)
    setStatus(brains[0], status('idle', { task: false, idleSince: -SLEEP_AFTER_SEC - 600 }), 0)
    run(crowd, 30)
    expect(brains[0].mode).toBe('sleep')
  })

  it('limite de uso: com tarefa espera sentado na mesa (sem fila do café); sem tarefa vai para a fila', () => {
    const { crowd, brains } = office(2)
    const [withTask, without] = brains
    setStatus(withTask, status('error', { usageOut: true, task: true }), 0)
    setStatus(without, status('error', { usageOut: true, task: false }), 0)
    const modes = new Set<Mode>()
    run(crowd, 25, modesOf(withTask, modes))
    expect([...modes]).toEqual(['work'])
    expect([withTask.sit, withTask.seat, withTask.action]).toEqual([1, 'chair', 'drum'])
    expect(without.mode).toBe('queue')
    expect(without.poi?.kind === 'coffee' || without.poi?.kind === 'queue').toBe(true)
  })

  it('o status do retrato chega ao cérebro: brainStatus leva a `task`', () => {
    const f = feed({ conversations: [conv('a', { messages: [], updatedAt: NOW - 1_000 })], activeId: 'a', queuedIds: new Set(['a']) })
    const s = snapshotOf(f, deriveOfficeModel(f, NOW), NOW).agents.get('conv:a')!
    expect(brainStatus(s, 0, NOW).task).toBe(true)
  })
})
