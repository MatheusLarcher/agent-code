import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { cameraPosition, planeEdge, screenPose, type CameraPose } from './cameraRig'
import { boardCounts, CONSOLE_AT, CONSOLE_PLANE } from './engineTv'

const FOV = 50
function ndc(pose: CameraPose, aspect: number, p: { x: number; y: number; z: number }): { x: number; y: number } {
  const cam = new PerspectiveCamera(FOV, aspect, 0.05, 250)
  const c = cameraPosition(pose)
  cam.position.set(c.x, c.y, c.z)
  cam.lookAt(pose.tx, pose.ty, pose.tz)
  cam.updateMatrixWorld()
  const v = new Vector3(p.x, p.y, p.z).project(cam)
  return { x: v.x, y: v.y }
}

describe('o console da Central (foco)', () => {
  it('a câmera olha a tela inclinada de frente (arfagem = −inclinação): em repouso ela é um retângulo — o encaixe é translação', () => {
    const aspect = 16 / 9
    const pose = screenPose(CONSOLE_AT, CONSOLE_PLANE, { fovDeg: FOV, aspect })
    expect(pose.pitch).toBeCloseTo(0.27)
    const corner = (sx: number, sy: number) => {
      const e = planeEdge(CONSOLE_PLANE, sy)
      return ndc(pose, aspect, { x: CONSOLE_AT.x + sx * CONSOLE_PLANE.halfW, y: CONSOLE_AT.y + e.dy, z: CONSOLE_AT.z + CONSOLE_PLANE.front + e.dz })
    }
    const tl = corner(-1, 1)
    const tr = corner(1, 1)
    const bl = corner(-1, -1)
    const br = corner(1, -1)
    expect(tl.y).toBeCloseTo(tr.y, 4)
    expect(bl.y).toBeCloseTo(br.y, 4)
    expect(tl.x).toBeCloseTo(bl.x, 4)
    expect(tr.x).toBeCloseTo(br.x, 4)
    // A tela de cima vai para trás (−Z) e a câmera fica acima e à frente (+Z).
    expect(planeEdge(CONSOLE_PLANE, 1).dz).toBeLessThan(0)
    const cam = cameraPosition(pose)
    expect(cam.y).toBeGreaterThan(CONSOLE_AT.y)
    expect(cam.z).toBeGreaterThan(CONSOLE_AT.z)
  })

  it('boardCounts: as colunas do Quadro (um projeto ou todos)', () => {
    const shown = (s: string[]) => ({ shown: s.map((status) => ({ status })) })
    const board = { sync: { roomIds: ['a', 'b'], mirror: (id: string) => (id === 'a' ? shown(['pending', 'in_progress', 'completed', 'completed']) : shown(['pending'])) } } as never
    expect(boardCounts(board, null)).toEqual({ todo: 2, doing: 1, done: 2 })
    expect(boardCounts(board, 'b')).toEqual({ todo: 1, doing: 0, done: 0 })
  })
})
