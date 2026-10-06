/**
 * A planta em U conferida sobre os módulos reais (as conferências do script
 * planta.mjs do plano viraram teste): mesas e cadeiras (sentada e recuada) sem
 * sobreposição, com retângulos orientados; o lugar de pé ao lado de cada
 * cadeira com folga; e caminho pela grade do nav.ts de dentro da porta — e da
 * cabeceira da mesa de reunião, de onde o herdeiro do Manager sai — até cada
 * cadeira e cada lugar fixo.
 */
import { describe, expect, it } from 'vitest'
import { createBrain, goDesk, goStand, move, type Brain, type BrainWorld } from './brainBody'
import { CHAIR_HALF, CHAIR_HD, chairSide, deskBox, roomFurniture, seatOf } from './furniture'
import { EMPTY_LAYOUT } from './layout'
import { managerSeat } from './meetingRoom'
import { AGENT_RADIUS, buildNavGrid } from './nav'
import {
  CENTRAL_SPOT,
  CHAIR_PULL,
  CONSOLE,
  DESK_D,
  DESK_W,
  deskPoint,
  DOOR,
  ENERGY_PANEL,
  FRONT_SPOTS,
  GLASS_X,
  ISLAND_SHELF,
  islandShelf,
  islandSideSpots,
  ISLANDS,
  MEMORY_SPOT_X,
  MEMORY_SPOTS_Z,
  MEMORY_WAIT,
  OFFICE,
  PLAZA_SPOTS,
  RIGHT_FACE_X,
  SEAT_FRONT,
  STATIONS,
  STATIONS_PER_ISLAND,
  U_EXTENT,
  WINDOW_SPOT_X,
  WINDOW_SPOTS_Z,
  zoneAt,
  type Placed
} from './officePlan'

interface Obb extends Placed {
  hw: number
  hd: number
  tag: string
}

const obb = (d: Placed, lx: number, lz: number, hw: number, hd: number, tag: string): Obb => ({ ...deskPoint(d, lx, lz), yaw: d.yaw, hw, hd, tag })
const rot = (yaw: number, lx: number, lz: number): { x: number; z: number } => deskPoint({ x: 0, z: 0, yaw }, lx, lz)

function corners(b: Obb): Array<{ x: number; z: number }> {
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => deskPoint(b, sx * b.hw, sz * b.hd))
}

/** Separação por eixos (SAT): os dois retângulos orientados se cruzam. */
function overlap(a: Obb, b: Obb): boolean {
  const ca = corners(a)
  const cb = corners(b)
  for (const ax of [rot(a.yaw, 1, 0), rot(a.yaw, 0, 1), rot(b.yaw, 1, 0), rot(b.yaw, 0, 1)]) {
    const pa = ca.map((p) => p.x * ax.x + p.z * ax.z)
    const pb = cb.map((p) => p.x * ax.x + p.z * ax.z)
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false
  }
  return true
}

/** Distância de um ponto ao retângulo orientado (0 dentro). */
function distTo(b: Obb, x: number, z: number): number {
  const c = Math.cos(b.yaw)
  const s = Math.sin(b.yaw)
  const dx = x - b.x
  const dz = z - b.z
  const lx = dx * c - dz * s
  const lz = dx * s + dz * c
  return Math.hypot(Math.max(0, Math.abs(lx) - b.hw), Math.max(0, Math.abs(lz) - b.hd))
}

const CHAIR_Z = SEAT_FRONT - 0.03
const parts = STATIONS.map((s) => ({
  s,
  top: obb(s, 0, 0, DESK_W / 2, DESK_D / 2, `mesa ${s.index}`),
  chair: obb(s, 0, CHAIR_Z, CHAIR_HALF, CHAIR_HD, `cadeira ${s.index}`),
  pulled: obb(s, 0, CHAIR_Z + CHAIR_PULL, CHAIR_HALF, CHAIR_HD, `cadeira recuada ${s.index}`)
}))
const shelves = ISLANDS.map((i) => obb(islandShelf(i.index), 0, 0, ISLAND_SHELF.w / 2, ISLAND_SHELF.d / 2, `estante ${i.index}`))

const furniture = roomFurniture({ id: 'office' })
const room = EMPTY_LAYOUT.rooms[0]
const grid = buildNavGrid(room, furniture)

describe('planta em U', () => {
  it('4 ilhas de 6 mesas (24), índice = ilha · 6 + k; os 4 braços inclinados 16–20° para dentro', () => {
    expect(STATIONS_PER_ISLAND).toBe(6)
    expect(STATIONS).toHaveLength(24)
    STATIONS.forEach((s, i) => {
      expect(s.index).toBe(i)
      expect(s.index).toBe(s.island * 6 + s.k)
      expect(zoneAt(s.x, s.z)).toBe(s.zone)
    })
    for (const isl of ISLANDS) {
      const arms = STATIONS.filter((s) => s.island === isl.index && s.k >= 2)
      expect(arms).toHaveLength(4)
      for (const a of arms) {
        const deg = (Math.abs(a.yaw) * 180) / Math.PI
        expect(deg).toBeGreaterThanOrEqual(16)
        expect(deg).toBeLessThanOrEqual(20)
        // Para dentro: o braço da esquerda gira a tela para +X (o miolo do U), o da direita para −X.
        expect(Math.sign(a.yaw)).toBe(a.x < isl.x ? 1 : -1)
      }
    }
  })

  it('nenhuma mesa, cadeira (sentada e recuada) ou estante se sobrepõe a outra', () => {
    const problems: string[] = []
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        for (const a of [parts[i].top, parts[i].pulled, parts[i].chair]) for (const b of [parts[j].top, parts[j].pulled, parts[j].chair]) if (overlap(a, b)) problems.push(`${a.tag} × ${b.tag}`)
      }
      for (const sh of shelves) for (const a of [parts[i].top, parts[i].pulled]) if (overlap(a, sh)) problems.push(`${a.tag} × ${sh.tag}`)
    }
    expect(problems).toEqual([])
  })

  it('o U cabe na extensão declarada e as ilhas não se encostam (corredores de 2,8 m no meio e 1,8 m no cruzado)', () => {
    for (const p of parts) {
      const isl = ISLANDS[p.s.island]
      for (const b of [p.top, p.pulled]) {
        for (const c of corners(b)) {
          expect(c.x - isl.x).toBeGreaterThanOrEqual(U_EXTENT.x0 - 0.005)
          expect(c.x - isl.x).toBeLessThanOrEqual(U_EXTENT.x1 + 0.005)
          expect(c.z - isl.z).toBeGreaterThanOrEqual(U_EXTENT.z0 - 0.005)
          expect(c.z - isl.z).toBeLessThanOrEqual(U_EXTENT.z1 + 0.01)
        }
      }
    }
    expect(ISLANDS[1].x + U_EXTENT.x0 - (ISLANDS[0].x + U_EXTENT.x1)).toBeCloseTo(2.8, 1)
    expect(ISLANDS[0].z + U_EXTENT.z0 - (ISLANDS[2].z + U_EXTENT.z1)).toBeCloseTo(1.8, 1)
    // O console da Central no meio do corredor cruzado; a porta e o quadro de energia na parede da direita.
    expect(CONSOLE.z).toBeCloseTo((ISLANDS[0].z + U_EXTENT.z0 + ISLANDS[2].z + U_EXTENT.z1) / 2, 1)
    expect(DOOR.z).toBe(CONSOLE.z)
    expect(ENERGY_PANEL.z).toBeGreaterThan(ISLANDS[1].z)
    expect(ENERGY_PANEL.z).toBeLessThan(ISLANDS[1].z + U_EXTENT.z1)
    expect(OFFICE.x1 - OFFICE.x0).toBeCloseTo(19.95, 1)
    expect(OFFICE.z1 - OFFICE.z0).toBeCloseTo(23.81, 1)
  })

  it('o lugar de pé ao lado de cada cadeira fica livre de toda mesa e cadeira (a do próprio lugar também)', () => {
    let min = Infinity
    for (const p of parts) {
      const st = chairSide(p.s)
      for (const o of parts) for (const b of [o.top, o.chair]) min = Math.min(min, distTo(b, st.x, st.z) - AGENT_RADIUS)
    }
    expect(min).toBeGreaterThan(0.03)
  })

  it('a caixa alinhada do retângulo girado contém o retângulo (o obstáculo do nav.ts)', () => {
    for (const p of parts) {
      for (const [b, lz, hw, hd] of [[p.top, 0, DESK_W / 2, DESK_D / 2], [p.chair, CHAIR_Z, CHAIR_HALF, CHAIR_HD]] as const) {
        const r = deskBox(p.s, 0, lz, hw, hd)
        for (const c of corners(b)) {
          expect(c.x).toBeGreaterThanOrEqual(r.x0 - 1e-9)
          expect(c.x).toBeLessThanOrEqual(r.x1 + 1e-9)
          expect(c.z).toBeGreaterThanOrEqual(r.z0 - 1e-9)
          expect(c.z).toBeLessThanOrEqual(r.z1 + 1e-9)
        }
      }
    }
    // Sem giro, é o próprio retângulo.
    expect(deskBox({ x: 1, z: 2 }, 0, 0, 0.5, 0.25)).toEqual({ x0: 0.5, z0: 1.75, x1: 1.5, z1: 2.25 })
  })

  /** Lugares fixos de gente que precisam de caminho: janela, "Posso?", Memórias, café, Central, praça e de pé nas ilhas. */
  const fixedSpots = (): Array<{ x: number; z: number; tag: string }> => [
    ...WINDOW_SPOTS_Z.map((z) => ({ x: WINDOW_SPOT_X, z, tag: `janela ${z}` })),
    ...FRONT_SPOTS.map((s) => ({ ...s, tag: `Posso? ${s.x},${s.z}` })),
    ...MEMORY_SPOTS_Z.map((z) => ({ x: MEMORY_SPOT_X, z, tag: `Memórias ${z}` })),
    { ...MEMORY_WAIT, tag: 'espera das Memórias' },
    ...furniture.pois.map((p) => ({ x: p.x, z: p.z, tag: p.id })),
    { ...CENTRAL_SPOT, tag: 'Central' },
    ...PLAZA_SPOTS.map((s) => ({ ...s, tag: `praça ${s.x},${s.z}` })),
    ...ISLANDS.flatMap((i) => islandSideSpots(i.index).map((s) => ({ ...s, tag: `de pé na ilha ${i.index}` })))
  ]

  it('todo lugar de pé (cadeiras e lugares fixos) é chão livre', () => {
    const blocked = [...STATIONS.map((s) => ({ ...chairSide(s), tag: `cadeira ${s.index}` })), ...fixedSpots()].filter((s) => !grid.isFree(s.x, s.z)).map((s) => s.tag)
    expect(blocked).toEqual([])
  })

  it('de dentro da porta e da cabeceira da reunião há caminho até cada cadeira e cada lugar fixo', () => {
    const head = managerSeat(0)!
    expect(head).not.toBeNull()
    const out = new Float32Array(64)
    const goals = [...STATIONS.map((s) => ({ ...chairSide(s), tag: `cadeira ${s.index}` })), ...fixedSpots()]
    const lost: string[] = []
    for (const from of [furniture.doorIn, { x: head.standX, z: head.standZ }]) {
      for (const g of goals) {
        const n = grid.findPath(from.x, from.z, g.x, g.z, out)
        const end = n > 0 ? Math.hypot(out[(n - 1) * 2] - g.x, out[(n - 1) * 2 + 1] - g.z) : Infinity
        if (n === 0 || end > 0.3) lost.push(`${from.x.toFixed(1)},${from.z.toFixed(1)} → ${g.tag}`)
        for (let i = 0; i < n; i++) if (!grid.isFree(out[i * 2], out[i * 2 + 1])) lost.push(`${g.tag}: passa por móvel`)
      }
    }
    expect(lost).toEqual([])
  })

  it('a casca acompanha o prédio: vidro à esquerda, parede da direita até o fim das ilhas da frente', () => {
    expect(GLASS_X).toBeLessThan(ISLANDS[0].x + U_EXTENT.x0 - 1.3)
    expect(RIGHT_FACE_X).toBeGreaterThan(ISLANDS[1].x + U_EXTENT.x1 + 1.3)
  })
})

describe('sentar e levantar nas mesas giradas do U', () => {
  /** Mundo mínimo: o caminho é a reta até o objetivo (só o movimento importa aqui). */
  const world = { plan: (b: Brain) => ((b.path[0] = b.goal.x), (b.path[1] = b.goal.z), 1) } as unknown as BrainWorld

  it('em cada uma das 24 mesas (retas e a ±0,28/±0,34): senta de frente para a tela e levanta para o lado sem entrar em mesa nem cadeira', () => {
    const bad: string[] = []
    for (const p of parts) {
      const s = p.s
      const desk = { x: s.x, z: s.z, yaw: s.yaw, out: s.out }
      const b = createBrain({ key: `k${s.index}`, role: 'desk', roomId: 'office', home: seatOf(desk), desk })
      // Começa sentado: no assento, girado como a mesa (de frente para o monitor).
      expect(b.sit).toBe(1)
      expect(b.yaw).toBeCloseTo(s.yaw)
      expect(Math.hypot(b.x - seatOf(desk).x, b.z - seatOf(desk).z)).toBeLessThan(1e-9)
      const check = (phase: string): void => {
        // O quadril (o centro do corpo) nunca entra no tampo, e fora do assento nunca entra em mesa ou cadeira de outra estação.
        if (distTo(p.top, b.x, b.z) < 0.05) bad.push(`${phase} ${s.index}: no tampo`)
        for (const o of parts) {
          if (o === p) continue
          for (const box of [o.top, o.chair]) if (distTo(box, b.x, b.z) < 0.15) bad.push(`${phase} ${s.index}: em ${box.tag}`)
        }
      }
      // Levanta: vai para um ponto longe; enquanto sai da cadeira, passa do assento ao lugar de pé.
      goStand(b, s.x, s.z + 8, 0, 'walk')
      for (let i = 0; i < 60 && b.sit > 0; i++) {
        move(b, 1 / 60, world)
        check('levantando')
      }
      const side = chairSide(desk)
      expect(Math.hypot(b.x - side.x, b.z - side.z)).toBeLessThan(1e-6)
      // Senta de novo: do lado da cadeira ao assento, virando para o rumo da mesa.
      Object.assign(b, { atSpot: true })
      goDesk(b, 'walk')
      for (let i = 0; i < 120 && !b.arrived; i++) {
        move(b, 1 / 60, world)
        check('sentando')
      }
      expect(b.sit).toBe(1)
      expect(b.yaw).toBeCloseTo(s.yaw, 2)
    }
    expect(bad).toEqual([])
  })
})
