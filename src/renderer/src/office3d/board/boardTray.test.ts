import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandoffChangedMsg } from '@shared/api'
import type { HandoffProjectSnapshot } from '@shared/handoffProject'
import type { HandoffEnvio, HandoffQueueItem } from '@shared/handoffTracking'
import { stepBrain } from '../brain'
import { createBrain, type Brain, type BrainWorld } from '../brainBody'
import { DESK, newErrand, TRAY, visitSpotOf, type BoardSpot, type BoardWorld } from '../brainBoard'
import { BoardTray, DELIVERY_MAX_MS, TRAY_STAND, type TrayHost } from './boardTray'
import type { TrayApi, TrayLook } from './queueTray'

const ROOM = 'c:/proj/a'
const item = (n: number, o: Partial<HandoffQueueItem> = {}): HandoffQueueItem => ({
  envioId: `e${n}`,
  conversationId: 'k1',
  conversationTitle: 'Conversa 1',
  projectCwd: 'C:\\proj\\a',
  planSlug: 'plano-a',
  planTitulo: 'Plano A',
  loteId: 'lote-a',
  ordem: n,
  arquivo: `p${n}.md`,
  estado: 'esperando',
  motivo: null,
  estimativaTotal: 20,
  planPosicao: 1,
  etapas: [],
  totalPrompts: 9,
  conteudo: `prompt ${n}`,
  ...o
})
const sent = (id: string): HandoffEnvio => ({ id, conversationId: 'k1', status: 'enviado', enviadoEm: '2026-10-07T09:00:00.000Z', motivo: null }) as HandoffEnvio

function fakeApi(): TrayApi & { items: HandoffQueueItem[]; envios: HandoffEnvio[]; poke(): void } {
  const cbs = new Set<() => void>()
  const on = (cb: () => void): (() => void) => {
    cbs.add(cb)
    return () => cbs.delete(cb)
  }
  const api = {
    items: [] as HandoffQueueItem[],
    envios: [] as HandoffEnvio[],
    poke: () => cbs.forEach((cb) => cb()),
    handoffQueueList: async () => ({ ok: true as const, items: api.items }),
    handoffList: async () => ({ ok: true as const, envios: api.envios }),
    onHandoffChanged: (cb: (msg: HandoffChangedMsg) => void) => on(() => cb({ conversationId: 'k1' })),
    onHandoffProjectChanged: (cb: (snapshot: HandoffProjectSnapshot) => void) => on(() => cb({ caseInsensitive: true, folders: [] }))
  }
  return api
}

/** Uma sala sem obstáculos: caminho em linha reta, quadro em z = −7. */
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

function setup(wall = ROOM) {
  let shown = wall
  const api = fakeApi()
  const po = createBrain({ key: `po:${ROOM}`, role: 'fixed', style: 'board', roomId: 'office', projectId: ROOM, home: { x: -2.05, z: -6.4, yaw: 0 } })
  const agent = createBrain({ key: 'conv:k1', role: 'desk', roomId: 'office', projectId: ROOM, home: { x: -4.9, z: 0.05, yaw: 0 }, desk: { x: -4.9, z: -0.9, yaw: 0, out: 1 } })
  agent.phase = 'working'
  const brains = new Map<string, Brain>([
    [po.key, po],
    [agent.key, agent]
  ])
  const looks: TrayLook[] = []
  const host: TrayHost = { brain: (k) => brains.get(k), shown: () => shown, view: () => ({ set: (l) => looks.push(l) }), live: () => true }
  let now = 0
  const tray = new BoardTray(host, api, () => now)
  const w = world()
  const step = (seconds: number, each?: () => void): void => {
    for (let t = 0; t < seconds; t += 0.05) {
      w.t += 0.05
      now += 50
      stepBrain(agent, 0.05, w)
      stepBrain(po, 0.05, w)
      tray.tick(now)
      each?.()
    }
  }
  return { api, po, agent, looks, tray, step, last: () => looks.at(-1)!, show: (id: string) => (shown = id) }
}

describe('a bandeja e a entrega da folha pelo PO (boardTray)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('folhas = envios na fila do projeto da parede; clipe na fila parada', async () => {
    const s = setup()
    s.api.items = [item(1, { estado: 'parada', motivo: 'falta o commit' }), item(2), item(3, { projectCwd: 'C:\\proj\\outro', envioId: 'x3' })]
    s.api.poke()
    await vi.runAllTimersAsync()
    s.tray.tick()
    expect(s.last()).toMatchObject({ sheets: 2, more: 0, stopped: true })
    expect(s.tray.tip()).toBe('Fila parada: falta o commit · 2 na fila')
    // O quadro troca de projeto: a bandeja passa a mostrar a fila do novo (sem esperar aviso da fila).
    s.show('c:/proj/outro')
    expect(s.tray.tick()).toBe(true)
    expect(s.last()).toMatchObject({ sheets: 1, stopped: false })
    expect(s.tray.tick()).toBe(false)
    s.tray.dispose()
  })

  it('o despachante solta o próximo: o PO pega a folha de cima, leva até a mesa do agente e volta', async () => {
    const s = setup()
    s.api.items = [item(1), item(2)]
    s.api.poke()
    await vi.runAllTimersAsync()
    s.step(1)
    expect(s.last().sheets).toBe(2)
    s.api.items = [item(2)]
    s.api.envios = [sent('e1')]
    s.api.poke()
    await vi.runAllTimersAsync()
    expect(s.tray.delivering).toEqual({ key: s.po.key, target: 'conv:k1', picked: false })
    expect(s.po.errand?.stops.map((x) => x.col)).toEqual([TRAY, DESK])
    // A folha que saiu continua na bandeja até o PO pegar.
    s.tray.tick()
    expect(s.last()).toMatchObject({ sheets: 2, stopped: false })
    const desk: BoardSpot = { x: 0, z: 0, yaw: 0, lx: 0, ly: 0, lz: 0 }
    visitSpotOf(s.agent, desk, false)
    let grabbedAtTray = false
    let pickedSheets = -1
    let delivered = false
    s.step(40, () => {
      if (s.po.action === 'grabBook' && Math.hypot(s.po.x - TRAY_STAND.x, s.po.z - TRAY_STAND.z) < 0.3) grabbedAtTray = true
      if (pickedSheets < 0 && s.tray.delivering?.picked) pickedSheets = s.last().sheets
      if (s.po.action === 'stick' && s.po.prop === 'note' && Math.hypot(s.po.x - desk.x, s.po.z - desk.z) < 0.3) delivered = true
    })
    expect(grabbedAtTray).toBe(true)
    expect(pickedSheets).toBe(1)
    expect(delivered).toBe(true)
    expect(s.tray.delivering).toBeNull()
    expect(s.po.errand).toBeNull()
    // Volta ao lugar dele.
    s.step(30)
    expect(Math.hypot(s.po.x - s.po.home.x, s.po.z - s.po.home.z)).toBeLessThan(0.3)
    s.tray.dispose()
  })

  it('PO ocupado (numa ida ao quadro) ou projeto fora da parede: a folha só some', async () => {
    const busy = setup()
    busy.api.items = [item(1), item(2)]
    busy.api.poke()
    await vi.runAllTimersAsync()
    busy.po.errand = newErrand([], 'walk')
    busy.api.items = [item(2)]
    busy.api.envios = [sent('e1')]
    busy.api.poke()
    await vi.runAllTimersAsync()
    busy.tray.tick()
    expect(busy.tray.delivering).toBeNull()
    expect(busy.last().sheets).toBe(1)
    busy.tray.dispose()
    const away = setup('c:/proj/outro')
    away.api.items = [item(1)]
    away.api.poke()
    await vi.runAllTimersAsync()
    away.api.items = []
    away.api.envios = [sent('e1')]
    away.api.poke()
    await vi.runAllTimersAsync()
    expect(away.tray.delivering).toBeNull()
    expect(away.po.errand).toBeNull()
    away.tray.dispose()
  })

  it('uma ida ao quadro no meio da entrega tem a vez; entrega presa passa de DELIVERY_MAX_MS e é largada', async () => {
    const s = setup()
    s.api.items = [item(1)]
    s.api.poke()
    await vi.runAllTimersAsync()
    s.api.items = []
    s.api.envios = [sent('e1')]
    s.api.poke()
    await vi.runAllTimersAsync()
    const board = newErrand([], 'walk')
    s.po.errand = board
    s.tray.tick()
    expect(s.tray.delivering).toBeNull()
    expect(s.po.errand).toBe(board)
    expect(s.last().sheets).toBe(0)
    s.tray.dispose()
    const stuck = setup()
    stuck.api.items = [item(1)]
    stuck.api.poke()
    await vi.runAllTimersAsync()
    stuck.api.items = []
    stuck.api.envios = [sent('e1')]
    stuck.api.poke()
    await vi.runAllTimersAsync()
    expect(stuck.tray.delivering).not.toBeNull()
    stuck.tray.tick(DELIVERY_MAX_MS + 1)
    expect(stuck.tray.delivering).toBeNull()
    expect(stuck.po.errand).toBeNull()
    stuck.tray.dispose()
  })
})
