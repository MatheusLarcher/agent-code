import { describe, expect, it } from 'vitest'
import { findPath, isWalkable, tileKey } from '../engine/tileMap'
import { buildTileMap, getBlockedTiles, roomAt, validateLayout } from '../engine/world'
import type { DestinationRole, OfficeLayout } from '../engine/types'
import { buildBuilding, type BuildingRoomInput } from './building'
import { SPECIALIST_SLOTS } from './roomTemplate'

function rooms(n: number, principals = 3): BuildingRoomInput[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, projectKey: `p${i}`, name: `Projeto ${i}`, principals }))
}

const ROOM_ROLES: DestinationRole[] = ['porta', 'kanban', 'impressora', 'reuniao', 'reuniao-cabeceira']
const COMMON_ROLES: DestinationRole[] = ['entrada', 'copa', 'arquivo-memorias']

/** Confere que todo assento de mesa e todo destino se alcança da porta da sala e da entrada. */
function assertReachable(layout: OfficeLayout): void {
  validateLayout(layout)
  const map = buildTileMap(layout)
  const blocked = getBlockedTiles(layout)
  const entrada = layout.destinations.find((d) => d.papel === 'entrada')!
  const entranceDoor = layout.furniture.find((f) => f.papel === 'entrada')!
  expect(isWalkable(entranceDoor.col, entranceDoor.row, map, blocked)).toBe(true)
  const reach = (from: { col: number; row: number }, to: { col: number; row: number }, label: string): void => {
    // O assento bloqueia os outros; o dono o desbloqueia para si (como no motor).
    const key = tileKey(to.col, to.row)
    const wasBlocked = blocked.delete(key)
    const path = findPath(from.col, from.row, to.col, to.row, map, blocked)
    if (wasBlocked) blocked.add(key)
    const same = from.col === to.col && from.row === to.row
    expect(same || path.length > 0, `${label} inalcançável`).toBe(true)
  }
  for (const room of layout.rooms) {
    const door = { col: room.doorCol, row: room.doorRow }
    expect(isWalkable(door.col, door.row, map, blocked)).toBe(true)
    for (const s of layout.seats.filter((s) => s.roomId === room.id && s.kind !== 'reuniao')) {
      reach(door, s, `assento ${s.uid} (porta)`)
      reach(entranceDoor, s, `assento ${s.uid} (entrada)`)
    }
  }
  for (const d of layout.destinations) {
    expect(isWalkable(d.col, d.row, map, blocked), `destino ${d.papel} não andável`).toBe(true)
    const room = layout.rooms.find((r) => r.id === d.roomId)
    if (room) reach({ col: room.doorCol, row: room.doorRow }, d, `${d.papel} de ${room.id} (porta)`)
    reach(entrada, d, `${d.papel}/${d.roomId} (entrada)`)
  }
}

describe('buildBuilding', () => {
  it('cada sala tem 8 principais e os 4 especialistas com vaga nomeada', () => {
    const layout = buildBuilding({ rooms: rooms(2) })
    for (const id of ['r0', 'r1']) {
      const s = layout.seats.filter((x) => x.roomId === id)
      expect(s.filter((x) => x.kind === 'principal')).toHaveLength(8)
      const esp = s.filter((x) => x.kind === 'especialista')
      expect(esp.map((x) => x.slot).sort()).toEqual([...SPECIALIST_SLOTS].sort())
      expect(s.filter((x) => x.kind === 'reuniao').length).toBeGreaterThanOrEqual(3)
      // Toda cadeira de mesa olha para cima e tem a mesa logo acima.
      for (const seat of s.filter((x) => x.kind !== 'reuniao')) {
        expect(seat.facingDir).toBe(3)
        const desk = layout.furniture.find((f) => f.uid === seat.deskUid)!
        expect(desk.deskOfSeat).toBe(seat.uid)
        expect(desk.row).toBe(seat.row - 1)
      }
    }
  })

  it('acima de 8 principais a sala ganha fileiras de 4 e cresce para baixo', () => {
    const base = buildBuilding({ rooms: [{ id: 'a', projectKey: 'a', name: 'A', principals: 8 }] })
    const big = buildBuilding({ rooms: [{ id: 'a', projectKey: 'a', name: 'A', principals: 12 }] })
    const huge = buildBuilding({ rooms: [{ id: 'a', projectKey: 'a', name: 'A', principals: 13 }] })
    expect(big.seats.filter((s) => s.kind === 'principal')).toHaveLength(12)
    expect(huge.seats.filter((s) => s.kind === 'principal')).toHaveLength(16)
    expect(big.rooms[0].h).toBe(base.rooms[0].h + 4)
    // Os especialistas não mudam de lugar dentro da sala quando ela cresce.
    const rel = (l: OfficeLayout, uid: string): string => {
      const s = l.seats.find((x) => x.uid === uid)!
      return `${s.col - l.rooms[0].col},${s.row - l.rooms[0].row}`
    }
    expect(rel(big, 'a:esp:executor')).toBe(rel(base, 'a:esp:executor'))
  })

  it('destinos por sala e no corredor, com o móvel marcado pelo papel', () => {
    const layout = buildBuilding({ rooms: rooms(3) })
    for (const r of layout.rooms) {
      for (const papel of ROOM_ROLES) {
        expect(layout.destinations.filter((d) => d.roomId === r.id && d.papel === papel)).toHaveLength(1)
        expect(layout.furniture.some((f) => f.roomId === r.id && f.papel === papel)).toBe(true)
      }
    }
    for (const papel of COMMON_ROLES) {
      const d = layout.destinations.filter((x) => x.roomId === null && x.papel === papel)
      expect(d).toHaveLength(1)
      expect(roomAt(layout.rooms, d[0].col, d[0].row)).toBeNull()
      expect(layout.furniture.some((f) => f.roomId === null && f.papel === papel)).toBe(true)
    }
  })

  it('a porta da sala abre para o corredor', () => {
    const layout = buildBuilding({ rooms: rooms(3) })
    for (const r of layout.rooms) {
      expect(r.doorRow).toBe(r.row + r.h - 1)
      expect(roomAt(layout.rooms, r.doorCol, r.doorRow + 1)).toBeNull()
    }
  })

  it.each([0, 1, 3, 5])('tudo alcançável com %i salas', (n) => {
    assertReachable(buildBuilding({ rooms: rooms(n) }))
  })

  it('tudo alcançável com uma sala de 12 principais entre salas normais', () => {
    const list = rooms(3)
    list[1] = { ...list[1], principals: 12 }
    assertReachable(buildBuilding({ rooms: list }))
  })

  it('tudo alcançável com vaga vazia no meio', () => {
    assertReachable(buildBuilding({ rooms: rooms(3), order: ['r0', '', 'r1', 'r2'] }))
  })

  it('é determinístico e os uids dependem só do roomId', () => {
    const a = buildBuilding({ rooms: rooms(3) })
    expect(buildBuilding({ rooms: rooms(3) })).toEqual(a)
    const alone = buildBuilding({ rooms: [rooms(3)[2]] })
    const uids = (l: OfficeLayout): string[] => l.seats.filter((s) => s.roomId === 'r2').map((s) => s.uid)
    expect(uids(alone)).toEqual(uids(a))
  })

  it('remover uma sala do meio (via order) não move as outras', () => {
    const before = buildBuilding({ rooms: rooms(3), order: ['r0', 'r1', 'r2'] })
    const after = buildBuilding({ rooms: [rooms(3)[0], rooms(3)[2]], order: ['r0', 'r1', 'r2'] })
    const pos = (l: OfficeLayout, id: string): unknown => l.rooms.find((r) => r.id === id)
    expect(pos(after, 'r2')).toEqual(pos(before, 'r2'))
    expect(pos(after, 'r0')).toEqual(pos(before, 'r0'))
  })

  it('recusa id vazio ou repetido', () => {
    expect(() => buildBuilding({ rooms: [{ id: '', projectKey: 'x', name: 'x', principals: 1 }] })).toThrow()
    expect(() => buildBuilding({ rooms: [rooms(1)[0], rooms(1)[0]] })).toThrow()
  })
})
