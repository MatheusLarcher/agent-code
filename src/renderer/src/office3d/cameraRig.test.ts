import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  cameraPosition,
  CameraRig,
  easeInOut,
  framePose,
  lerpPose,
  MONITOR_FILL,
  MONITOR_HALF_H,
  MONITOR_HALF_W,
  MONITOR_SCREEN_FRONT,
  monitorPose,
  projectPoint,
  TWEEN_MS,
  type CameraPose
} from './cameraRig'
import { SCREEN_H, SCREEN_W } from './kit'
import { buildingBounds, layoutOffice } from './layout'

const FOV = 50

/** Projeta com a câmera do three (independente de projectPoint). */
function ndc(pose: CameraPose, aspect: number, p: { x: number; y: number; z: number }): { x: number; y: number } {
  const cam = new PerspectiveCamera(FOV, aspect, 0.05, 250)
  const c = cameraPosition(pose)
  cam.position.set(c.x, c.y, c.z)
  cam.lookAt(pose.tx, pose.ty, pose.tz)
  cam.updateMatrixWorld()
  const v = new Vector3(p.x, p.y, p.z).project(cam)
  return { x: v.x, y: v.y }
}

/** Fração da largura e da altura do palco ocupada pela tela do monitor. */
function screenFill(aspect: number): { w: number; h: number } {
  const m = { x: 3, y: 1.12, z: 2 }
  const pose = monitorPose(m, { fovDeg: FOV, aspect })
  const z = m.z + MONITOR_SCREEN_FRONT
  const a = ndc(pose, aspect, { x: m.x - MONITOR_HALF_W, y: m.y + MONITOR_HALF_H, z })
  const b = ndc(pose, aspect, { x: m.x + MONITOR_HALF_W, y: m.y - MONITOR_HALF_H, z })
  return { w: Math.abs(b.x - a.x) / 2, h: Math.abs(a.y - b.y) / 2 }
}

describe('monitorPose', () => {
  it('o monitor da câmera tem as medidas da tela desenhada na cena (kit.ts)', () => {
    expect(MONITOR_HALF_W * 2).toBe(SCREEN_W)
    expect(MONITOR_HALF_H * 2).toBe(SCREEN_H)
  })

  it('palco largo (16:9): a altura limita e a tela ocupa ~85% dela', () => {
    const f = screenFill(16 / 9)
    expect(f.h).toBeCloseTo(MONITOR_FILL, 1)
    expect(f.h).toBeGreaterThan(0.82)
    expect(f.h).toBeLessThan(0.88)
    expect(f.w).toBeLessThan(f.h)
  })

  it('palco estreito (0.4): a largura limita e a tela cabe com margem', () => {
    const f = screenFill(0.4)
    expect(f.w).toBeGreaterThan(0.82)
    expect(f.w).toBeLessThan(0.88)
    expect(f.h).toBeLessThan(f.w)
  })

  it('palco mais estreito afasta a câmera', () => {
    const m = { x: 0, y: 1, z: 0 }
    expect(monitorPose(m, { fovDeg: FOV, aspect: 0.4 }).distance).toBeGreaterThan(monitorPose(m, { fovDeg: FOV, aspect: 16 / 9 }).distance)
  })
})

describe('framePose', () => {
  const rooms = (n: number) =>
    layoutOffice({ rooms: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, projectKey: `r${i}`, name: `r${i}`, icon: null, principals: 0 })), characters: [] }).rooms

  for (const aspect of [16 / 9, 0.4]) {
    it(`5 salas em grade cabem inteiras no palco (aspect ${aspect.toFixed(2)})`, () => {
      const b = buildingBounds(rooms(5))!
      const box = { ...b, height: 1.8 }
      const pose = framePose(box, { fovDeg: FOV, aspect })
      let maxX = 0
      let maxY = 0
      for (const x of [box.minX, box.maxX])
        for (const y of [0, box.height])
          for (const z of [box.minZ, box.maxZ]) {
            const q = ndc(pose, aspect, { x, y, z })
            maxX = Math.max(maxX, Math.abs(q.x))
            maxY = Math.max(maxY, Math.abs(q.y))
            // A projeção própria concorda com a do three.
            const own = projectPoint(pose, { fovDeg: FOV, aspect }, { x, y, z })
            expect(own.x).toBeCloseTo(q.x, 5)
            expect(own.y).toBeCloseTo(q.y, 5)
          }
      expect(maxX).toBeLessThanOrEqual(0.9 + 1e-6)
      expect(maxY).toBeLessThanOrEqual(0.9 + 1e-6)
      // Justo: a dimensão que limita encosta na margem (não fica longe à toa).
      expect(Math.max(maxX, maxY)).toBeGreaterThan(0.89)
    })
  }

  it('voo da câmera: cada quadro escreve na MESMA pose (sem objeto novo) e termina no destino', () => {
    const from = { tx: 0, ty: 0, tz: 0, yaw: 0.2, pitch: 0.5, distance: 10 }
    const rig = new CameraRig(from)
    const pose = rig.pose
    const to: CameraPose = { tx: 4, ty: 1, tz: -2, yaw: 3, pitch: 0.2, distance: 2 }
    rig.flyTo(to, 0)
    expect(rig.step(TWEEN_MS / 2)).toBe(true)
    expect(rig.pose).toBe(pose)
    const mid = lerpPose(from, to, easeInOut(0.5))
    for (const k of Object.keys(mid) as Array<keyof CameraPose>) expect(rig.pose[k]).toBeCloseTo(mid[k], 9)
    for (let t = TWEEN_MS / 2 + 16; t < TWEEN_MS; t += 16) {
      expect(rig.step(t)).toBe(true)
      expect(rig.pose).toBe(pose)
    }
    expect(rig.step(TWEEN_MS)).toBe(false)
    expect(rig.pose).toBe(pose)
    expect(rig.pose).toEqual(to)
    const out = { x: 0, y: 0, z: 0 }
    expect(cameraPosition(rig.pose, out)).toBe(out)
    expect(out).toEqual(cameraPosition(to))
  })

  it('mira no centro do prédio', () => {
    const b = buildingBounds(rooms(5))!
    const pose = framePose({ ...b, height: 1.8 }, { fovDeg: FOV, aspect: 1.5 })
    expect(pose.tx).toBeCloseTo((b.minX + b.maxX) / 2)
    expect(pose.tz).toBeCloseTo((b.minZ + b.maxZ) / 2)
  })
})
