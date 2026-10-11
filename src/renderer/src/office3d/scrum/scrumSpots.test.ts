/**
 * O lugar do Scrum Master no escritório: à direita do quadro (o PO fica à esquerda), entre a borda dele e
 * o vidro da sala de reunião, virado para o quadro, fora do enquadramento do clique no quadro e em chão
 * livre da grade de navegação (com caminho desde a porta). E o modelo: um SM por sala com quadro.
 */
import { describe, expect, it } from 'vitest'
import { deriveOfficeModel, type OfficeCharacterModel } from '../../office/adapter/model'
import type { OfficeFeed } from '../../office/adapter/feed'
import type { Conversation } from '../../types'
import { projectPoint, screenPose } from '../cameraRig'
import { BOARD_AT, BOARD_PLANE } from '../engineTv'
import { boardPlace, roomFurniture } from '../furniture'
import { layoutOffice } from '../layout'
import { buildNavGrid } from '../nav'
import { MEETING, PO_SPOTS, SCRUM_SPOTS } from '../officePlan'
import { focusView } from '../screenAnchor'

const board = boardPlace()
const STAGES: ReadonlyArray<readonly [number, number]> = [[1024, 768], [1280, 1024], [1440, 900], [1600, 900], [1920, 1080], [2560, 1080], [3440, 1440]]
const body = (s: { x: number; z: number }): Array<{ x: number; y: number; z: number }> =>
  [-0.25, 0.25].flatMap((dx) => [0, 1.9].flatMap((y) => [-0.25, 0.25].map((dz) => ({ x: s.x + dx, y, z: s.z + dz }))))

describe('o Scrum Master parado à direita do quadro', () => {
  it('todos os lugares ficam à direita do quadro, antes do vidro da reunião, virados para ele', () => {
    for (const s of SCRUM_SPOTS) {
      expect(s.x, `${s.x},${s.z}`).toBeGreaterThan(board.x1)
      expect(s.x + 0.25, `${s.x},${s.z}`).toBeLessThan(MEETING.x0)
      const fx = -Math.sin(s.yaw)
      const fz = -Math.cos(s.yaw)
      const len = Math.hypot(board.x - s.x, BOARD_AT.z - s.z)
      expect((fx * (board.x - s.x) + fz * (BOARD_AT.z - s.z)) / len, `${s.x},${s.z}`).toBeGreaterThan(0.99)
    }
    // Do outro lado do PO.
    for (const s of PO_SPOTS) expect(s.x).toBeLessThan(board.x0)
  })

  it('no clique no quadro, nenhum lugar entra no enquadramento (nenhuma coluna tapada)', () => {
    for (const [w, h] of STAGES) {
      const view = focusView(50, w, h)
      const pose = screenPose(BOARD_AT, BOARD_PLANE, view)
      for (const s of SCRUM_SPOTS) {
        for (const p of body(s)) {
          const q = projectPoint(pose, view, p)
          expect(q.depth > 0 && Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1, `${w}x${h}: (${p.x}, ${p.y}, ${p.z}) do lugar ${s.x},${s.z}`).toBe(false)
        }
      }
    }
  })

  it('chão livre na grade de navegação, com caminho desde a porta', () => {
    const principal = (conv: string): OfficeCharacterModel => ({
      key: `conv:${conv}`, convId: conv, roomId: 'r1', role: 'principal', placement: { kind: 'seat', seatKind: 'principal' },
      seed: `conv:${conv}`, active: false, activity: null, bubble: null, label: ''
    })
    const room = layoutOffice({ rooms: [{ id: 'r1', projectKey: 'r1', name: 'r1', icon: null, principals: 2 }], characters: ['a', 'b'].map(principal) }).rooms[0]
    const furniture = roomFurniture(room)
    const grid = buildNavGrid(room, furniture)
    const out = new Float32Array(64)
    for (const s of SCRUM_SPOTS) {
      expect(grid.isFree(s.x, s.z), `${s.x},${s.z}`).toBe(true)
      expect(grid.findPath(furniture.doorIn.x, furniture.doorIn.z, s.x, s.z, out), `${s.x},${s.z}`).toBeGreaterThan(0)
    }
  })
})

const NOW = 1_800_000_000_000
const conv = (id: string, cwd: string): Conversation => ({ id, title: id, cwd, messages: [], createdAt: NOW, updatedAt: NOW }) as unknown as Conversation
function feed(scrum: boolean | undefined, convs: Conversation[]): OfficeFeed {
  return {
    conversations: convs, busyIds: new Set(convs.map((c) => c.id)), busySince: {}, permissions: {}, vigiaAlerts: {}, vigiaAt: {},
    poDiagnostics: {}, memoristaDiagnostics: {}, observersOn: { po: false, vigia: false, memorista: false, ...(scrum === undefined ? {} : { scrum }) },
    stalledSince: {}, tracks: {}, projectIcons: {}
  } as unknown as OfficeFeed
}

describe('o Scrum Master no modelo do escritório', () => {
  const convs = [conv('a', 'C:/p1'), conv('b', 'C:/p2')]
  const rooms = (m: ReturnType<typeof deriveOfficeModel>): string[] => m.rooms.map((r) => r.id)

  it('um por sala com quadro, com chave scrum:<sala>, papel fixo no lugar dele', () => {
    const base = deriveOfficeModel(feed(true, convs), NOW)
    const ids = rooms(base)
    const m = deriveOfficeModel(feed(true, convs), NOW, new Set([ids[0]]))
    const sms = m.characters.filter((c) => c.role === 'scrum')
    expect(sms.map((c) => c.key)).toEqual([`scrum:${ids[0]}`])
    expect(sms[0].placement).toEqual({ kind: 'destination', papel: 'scrum' })
    const l = layoutOffice(m)
    const at = l.characters.find((c) => c.key === `scrum:${ids[0]}`)!
    expect([at.x, at.z, at.spot]).toEqual([SCRUM_SPOTS[0].x, SCRUM_SPOTS[0].z, 'scrum'])
  })

  it('desligado (ou feed sem o campo), some', () => {
    const ids = rooms(deriveOfficeModel(feed(true, convs), NOW))
    for (const on of [false, undefined]) {
      expect(deriveOfficeModel(feed(on, convs), NOW, new Set(ids)).characters.some((c) => c.role === 'scrum')).toBe(false)
    }
  })
})
