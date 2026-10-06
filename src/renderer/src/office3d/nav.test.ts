import { describe, expect, it } from 'vitest'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { chairSide, meetingChairs, roomFurniture, seatOf } from './furniture'
import { layoutOffice, type RoomLayout } from './layout'
import { AGENT_RADIUS, buildNavGrid, CELL, NavGrid, PoiBook } from './nav'
import { CENTRAL_SPOT, COFFEE, CONSOLE, LOUNGE, LOUNGE_SEATS, MEETING, MEMORY_SHELF, MEMORY_SPOT_X, MEMORY_SPOTS_Z, MEMORY_WAIT, PO_SPOTS, STATIONS } from './officePlan'

function principal(conv: string): OfficeCharacterModel {
  return {
    key: `conv:${conv}`, convId: conv, roomId: 'r1', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
    seed: `conv:${conv}`, active: false, activity: null, bubble: null, label: ''
  }
}

/** O escritório (fixo: 24 estações em 4 ilhas em U, com ou sem gente). */
const room: RoomLayout = layoutOffice({ rooms: [{ id: 'r1', projectKey: 'r1', name: 'r1', icon: null, principals: 5 }], characters: ['a', 'b', 'c', 'd', 'e'].map(principal) }).rooms[0]
const furniture = roomFurniture(room)
const grid = buildNavGrid(room, furniture)
/** Os lugares de pé da estante de Memórias e o de espera atrás deles. */
const MEMORY = [...MEMORY_SPOTS_Z.map((z) => ({ x: MEMORY_SPOT_X, z })), MEMORY_WAIT]

/** O caminho inteiro passa só por células livres (segmento a segmento). */
function walkable(g: NavGrid, ax: number, az: number, pts: Float32Array, n: number): boolean {
  let px = ax
  let pz = az
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2]
    const z = pts[i * 2 + 1]
    if (i > 0 && !g.clear(px, pz, x, z)) return false
    px = x
    pz = z
  }
  return true
}

describe('grade de navegação', () => {
  it('célula de no máximo 0,5 m cobrindo a sala inteira', () => {
    expect(CELL).toBeLessThanOrEqual(0.5)
    expect(grid.cols * CELL).toBeGreaterThanOrEqual(room.width)
    expect(grid.rows * CELL).toBeGreaterThanOrEqual(room.depth)
  })

  it('mesas, cadeiras e móveis bloqueiam; corredores, lugares fixos e pontos de interesse ficam livres', () => {
    expect(room.desks).toHaveLength(24)
    for (const d of room.desks) {
      expect(grid.isFree(d.x, d.z)).toBe(false)
      expect(grid.isFree(d.x + 0.7, d.z)).toBe(false)
      const seat = seatOf(d)
      expect(grid.isFree(seat.x, seat.z)).toBe(false)
      // Ao lado da cadeira, do lado de fora da ilha (onde se senta e levanta), é chão livre.
      const side = chairSide(d)
      expect(Math.sign(side.x - d.x)).toBe(d.out)
      expect(grid.isFree(side.x, side.z), `mesa ${d.index}`).toBe(true)
    }
    for (const [x, z] of [
      [COFFEE.x, COFFEE.z],
      [MEMORY_SHELF.x, MEMORY_SHELF.z],
      [CONSOLE.x, CONSOLE.z],
      [LOUNGE.sofa.x, LOUNGE.sofa.z],
      [LOUNGE.table.x, LOUNGE.table.z],
      [MEETING.table.x, MEETING.table.z],
      ...meetingChairs().map((c) => [c.x, c.z])
    ]) {
      expect(grid.isFree(x, z)).toBe(false)
    }
    const f = furniture
    for (const p of f.pois) expect(grid.isFree(p.x, p.z), p.id).toBe(true)
    for (const s of [...PO_SPOTS, CENTRAL_SPOT, ...MEMORY, ...LOUNGE_SEATS.map((l) => ({ x: l.standX, z: l.standZ }))]) expect(grid.isFree(s.x, s.z), `${s.x},${s.z}`).toBe(true)
    expect(grid.isFree(f.doorIn.x, f.doorIn.z)).toBe(true)
    // Corredores: o cruzado (porta → Central), a pista central e o do fundo.
    expect(grid.isFree(6.5, CONSOLE.z)).toBe(true)
    expect(grid.isFree(0, 10)).toBe(true)
    expect(grid.isFree(-4.25, -2.6)).toBe(true)
  })

  it('de dentro da porta chega a todo ponto de interesse, a cada mesa e à mesa de reunião (pela porta de vidro)', () => {
    const out = new Float32Array(64)
    const from = furniture.doorIn
    const goals = [...furniture.pois, ...room.desks.map((d) => chairSide(d)), ...PO_SPOTS, CENTRAL_SPOT, ...MEMORY]
    for (const g of goals) {
      const n = grid.findPath(from.x, from.z, g.x, g.z, out)
      expect(n, `${g.x},${g.z}`).toBeGreaterThan(0)
      // Nenhum ponto do caminho cai dentro de móvel (a reta entre eles é amostrada: rente à quina pode raspar a folga).
      for (let i = 0; i < n; i++) expect(grid.isFree(out[i * 2], out[i * 2 + 1]), `${g.x},${g.z}`).toBe(true)
    }
    // Dentro da sala de reunião, ao lado da mesa: o caminho passa pelo vão da porta de vidro.
    const inside = { x: MEETING.table.x - 1.6, z: MEETING.table.z - 1.2 }
    expect(grid.isFree(inside.x, inside.z)).toBe(true)
    const n = grid.findPath(from.x, from.z, inside.x, inside.z, out)
    expect(n).toBeGreaterThan(1)
    expect(walkable(grid, from.x, from.z, out, n)).toBe(true)
    let door = false
    for (let i = 0; i + 1 < n; i++) {
      const [ax, az, bx, bz] = [out[i * 2], out[i * 2 + 1], out[i * 2 + 2], out[i * 2 + 3]]
      if ((az - MEETING.z1) * (bz - MEETING.z1) <= 0) {
        const x = ax + ((bx - ax) * (MEETING.z1 - az)) / (bz - az || 1)
        door ||= x > MEETING.door.x0 && x < MEETING.door.x1
      }
    }
    expect(door).toBe(true)
    expect(STATIONS).toHaveLength(24)
  })

  it('A* contorna as mesas e termina exatamente no destino', () => {
    const from = furniture.doorIn
    const to = furniture.pois.find((p) => p.kind === 'window')!
    const out = new Float32Array(64)
    const n = grid.findPath(from.x, from.z, to.x, to.z, out)
    expect(n).toBeGreaterThan(1)
    expect([out[(n - 1) * 2], out[(n - 1) * 2 + 1]]).toEqual([Math.fround(to.x), Math.fround(to.z)])
    expect(walkable(grid, from.x, from.z, out, n)).toBe(true)
    // Nenhum ponto cai dentro de móvel.
    for (let i = 0; i < n; i++) expect(grid.isFree(out[i * 2], out[i * 2 + 1])).toBe(true)
  })

  it('suaviza: em campo aberto vai em linha reta (1 ponto), contornando usa poucos pontos', () => {
    const out = new Float32Array(64)
    const a = furniture.pois.find((p) => p.id.endsWith('chat|0'))!
    const b = furniture.pois.find((p) => p.id.endsWith('chat|1'))!
    expect(grid.findPath(a.x, a.z, b.x, b.z, out)).toBe(1)
    // Da porta até a cadeira mais distante: bem menos pontos que células percorridas.
    const far = chairSide(room.desks[3])
    const n = grid.findPath(furniture.doorIn.x, furniture.doorIn.z, far.x, far.z, out)
    const straight = Math.hypot(far.x - furniture.doorIn.x, far.z - furniture.doorIn.z) / CELL
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(straight / 3)
  })

  it('sai de dentro de um móvel pela célula livre mais próxima', () => {
    const seat = seatOf(room.desks[0])
    const target = furniture.pois.find((p) => p.kind === 'window')!
    const out = new Float32Array(64)
    const n = grid.findPath(seat.x, seat.z, target.x, target.z, out)
    expect(n).toBeGreaterThan(0)
    expect(grid.isFree(out[0], out[1])).toBe(true)
    expect(Math.hypot(out[0] - seat.x, out[1] - seat.z)).toBeLessThan(1)
  })

  it('sem passagem não há caminho; a folga do raio bloqueia frestas estreitas', () => {
    // Caixa 4×4 com uma parede inteira no meio.
    const walled = new NavGrid(0, 0, 4, 4, [{ x0: 1.9, z0: 0, x1: 2.1, z1: 4 }])
    expect(walled.findPath(0.5, 2, 3.5, 2, new Float32Array(16))).toBe(0)
    // Fresta de 0,3 m (menor que o diâmetro do agente) também não passa.
    const slit = new NavGrid(0, 0, 4, 4, [
      { x0: 1.9, z0: 0, x1: 2.1, z1: 1.85 },
      { x0: 1.9, z0: 2.15, x1: 2.1, z1: 4 }
    ])
    expect(0.3).toBeLessThan(AGENT_RADIUS * 2)
    expect(slit.findPath(0.5, 2, 3.5, 2, new Float32Array(16))).toBe(0)
    // Com uma porta larga, passa e desvia pela porta.
    const door = new NavGrid(0, 0, 4, 4, [
      { x0: 1.9, z0: 0, x1: 2.1, z1: 1.2 },
      { x0: 1.9, z0: 2.8, x1: 2.1, z1: 4 }
    ])
    const out = new Float32Array(32)
    const n = door.findPath(0.5, 0.3, 3.5, 0.3, out)
    expect(n).toBeGreaterThan(1)
    expect(walkable(door, 0.5, 0.3, out, n)).toBe(true)
    // Algum ponto do desvio passa pelo vão (z entre 1,2 e 2,8).
    let through = false
    for (let i = 0; i < n; i++) through ||= out[i * 2 + 1] > 1.2 && out[i * 2 + 1] < 2.8
    expect(through).toBe(true)
  })

  it('pontos de interesse: ids únicos, pares de conversa de frente um para o outro, porta fora da sala', () => {
    const ids = furniture.pois.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const k of ['coffee', 'shelf', 'window', 'plant', 'postit', 'sofa', 'queue', 'chat', 'board']) {
      expect(furniture.pois.some((p) => p.kind === k), k).toBe(true)
    }
    const chats = furniture.pois.filter((p) => p.kind === 'chat')
    for (let i = 0; i < chats.length; i += 2) {
      const [a, b] = [chats[i], chats[i + 1]]
      // a olha para b e b para a (yaw 0 = -Z, -π/2 = +X).
      expect(Math.atan2(-(b.x - a.x), -(b.z - a.z))).toBeCloseTo(a.yaw)
      expect(Math.atan2(-(a.x - b.x), -(a.z - b.z))).toBeCloseTo(b.yaw)
    }
    // A porta é na parede da direita: do lado de fora fica além do escritório.
    expect(furniture.doorOut.x).toBeGreaterThan(room.x + room.width)
    expect(furniture.doorIn.x).toBeLessThan(room.x + room.width)
    // A fila do café cresce para −X.
    const queue = furniture.pois.filter((p) => p.kind === 'coffee' || p.kind === 'queue')
    for (let i = 1; i < queue.length; i++) expect(queue[i].x).toBeLessThan(queue[i - 1].x)
  })
})

describe('o kanban na parede do fundo', () => {
  it('um lugar livre diante de cada coluna, olhando para o quadro; o PO de pé ao lado; o cesto bloqueia', () => {
    const b = furniture.board
    const spots = furniture.pois.filter((p) => p.kind === 'board')
    expect(spots.map((p) => p.index)).toEqual([0, 1, 2])
    for (const p of spots) {
      expect(grid.isFree(p.x, p.z)).toBe(true)
      expect(p.x).toBeGreaterThan(b.x0)
      expect(p.x).toBeLessThan(b.x1)
      expect(p.yaw).toBe(0)
      expect(p.look.z).toBe(b.z)
    }
    const po = layoutOffice({ rooms: [{ id: 'r1', projectKey: 'r1', name: 'r1', icon: null, principals: 0 }], characters: [{ ...principal('x'), key: 'po:r1', role: 'po', placement: { kind: 'destination', papel: 'kanban' } }] }).characters[0]
    expect(grid.isFree(po.x, po.z)).toBe(true)
    expect(po.x).toBeLessThan(b.x1)
    expect(grid.isFree(b.bin.x, b.bin.z)).toBe(false)
  })

  it('o quadro fica no centro da parede do fundo, entre o lounge e a sala de reunião', () => {
    const b = furniture.board
    expect(b.x0).toBeGreaterThan(LOUNGE.sideboard.x + LOUNGE.sideboard.w / 2)
    expect(b.x1).toBeLessThan(MEETING.x0)
    expect(Math.abs((b.x0 + b.x1) / 2)).toBeLessThan(0.5)
  })
})

describe('reserva de pontos de interesse', () => {
  it('um agente por POI; o dono pode reservar de novo; soltar libera', () => {
    const book = new PoiBook()
    expect(book.claim('r1|coffee|0', 'a')).toBe(true)
    expect(book.claim('r1|coffee|0', 'b')).toBe(false)
    expect(book.claim('r1|coffee|0', 'a')).toBe(true)
    expect(book.holder('r1|coffee|0')).toBe('a')
    expect(book.isFree('r1|coffee|0')).toBe(false)
    expect(book.isFree('r1|coffee|0', 'a')).toBe(true)
    book.release('r1|coffee|0', 'b')
    expect(book.holder('r1|coffee|0')).toBe('a')
    book.release('r1|coffee|0', 'a')
    expect(book.claim('r1|coffee|0', 'b')).toBe(true)
  })

  it('releaseAll solta tudo de um agente; dropRoom solta tudo de uma sala', () => {
    const book = new PoiBook()
    book.claim('r1|chat|0', 'a')
    book.claim('r1|window|1', 'a')
    book.claim('r2|window|0', 'b')
    book.claim('r1|shelf|0', 'b')
    book.releaseAll('a')
    expect(book.isFree('r1|chat|0') && book.isFree('r1|window|1')).toBe(true)
    expect(book.size).toBe(2)
    book.dropRoom('r1')
    expect(book.holder('r1|shelf|0')).toBeUndefined()
    expect(book.holder('r2|window|0')).toBe('b')
  })
})
