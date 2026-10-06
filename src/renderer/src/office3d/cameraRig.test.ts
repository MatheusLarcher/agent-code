import { PerspectiveCamera, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import {
  cameraPosition,
  CameraRig,
  easeInOut,
  framePose,
  lerpPose,
  MONITOR_BOTTOM_GAP,
  MONITOR_FILL,
  MONITOR_HALF_H,
  MONITOR_HALF_W,
  MONITOR_SCREEN_FRONT,
  monitorPose,
  projectPoint,
  TV_PLANE,
  tvPose,
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

describe('tvPose (o foco dentro da TV)', () => {
  it('de frente e SEM arfagem: em repouso a TV é um retângulo (encaixe = translação pura) e ocupa ~94% do palco', () => {
    const tv = { x: 5.05, y: 1.6, z: -6.5 }
    const aspect = 16 / 9
    const pose = tvPose(tv, { fovDeg: FOV, aspect })
    expect([pose.yaw, pose.pitch]).toEqual([0, 0])
    const z = tv.z + TV_PLANE.front
    const tl = ndc(pose, aspect, { x: tv.x - TV_PLANE.halfW, y: tv.y + TV_PLANE.halfH, z })
    const tr = ndc(pose, aspect, { x: tv.x + TV_PLANE.halfW, y: tv.y + TV_PLANE.halfH, z })
    const bl = ndc(pose, aspect, { x: tv.x - TV_PLANE.halfW, y: tv.y - TV_PLANE.halfH, z })
    expect(tl.y).toBeCloseTo(tr.y, 6)
    expect(tl.x).toBeCloseTo(bl.x, 6)
    expect(Math.max((tr.x - tl.x) / 2, (tl.y - bl.y) / 2)).toBeCloseTo(MONITOR_FILL, 1)
  })
})

describe('monitorPose', () => {
  it('monitor girado (os braços do U, ±0,28/±0,34): a câmera para de frente para a tela — no eixo dela, com o yaw dela — e a tela fica um retângulo', () => {
    const aspect = 16 / 9
    for (const yaw of [0.28, -0.28, 0.34, -0.34]) {
      const m = { x: -2.4, y: 1.12, z: 9.4, yaw }
      const pose = monitorPose(m, { fovDeg: FOV, aspect })
      expect(pose.yaw).toBeCloseTo(yaw)
      expect(pose.pitch).toBe(0)
      // A câmera no prolongamento da normal da tela (sin yaw, cos yaw).
      const c = cameraPosition(pose)
      const dx = c.x - m.x
      const dz = c.z - m.z
      expect(dx * Math.cos(yaw) - dz * Math.sin(yaw)).toBeCloseTo(0, 6)
      expect(dx * Math.sin(yaw) + dz * Math.cos(yaw)).toBeGreaterThan(0.5)
      // Os cantos da tela girada: os de cima na mesma altura, os da esquerda no mesmo x (retângulo alinhado).
      const corner = (sx: number, sy: number): { x: number; y: number } => {
        const lx = sx * MONITOR_HALF_W
        const lz = MONITOR_SCREEN_FRONT
        return ndc(pose, aspect, { x: m.x + lx * Math.cos(yaw) + lz * Math.sin(yaw), y: m.y + sy * MONITOR_HALF_H, z: m.z - lx * Math.sin(yaw) + lz * Math.cos(yaw) })
      }
      const tl = corner(-1, 1)
      const tr = corner(1, 1)
      const bl = corner(-1, -1)
      expect(tl.y).toBeCloseTo(tr.y, 6)
      expect(tl.x).toBeCloseTo(bl.x, 6)
      expect(tr.x).toBeGreaterThan(tl.x)
    }
  })

  it('o monitor da câmera tem as medidas da tela desenhada na cena (kit.ts)', () => {
    expect(MONITOR_HALF_W * 2).toBe(SCREEN_W)
    expect(MONITOR_HALF_H * 2).toBe(SCREEN_H)
  })

  it('de frente e SEM arfagem (como a TV): parada, a tela do monitor é um retângulo — o encaixe plano e nítido — mesmo descendo para livrar o HUD', () => {
    const m = { x: 3, y: 1.12, z: 2 }
    const aspect = 16 / 9
    const pose = monitorPose(m, { fovDeg: FOV, aspect, heightPx: 900, clearTopPx: 56 })
    expect(pose.pitch).toBe(0)
    const z = m.z + MONITOR_SCREEN_FRONT
    const at = (sx: number, sy: number) => ndc(pose, aspect, { x: m.x + sx * MONITOR_HALF_W, y: m.y + sy * MONITOR_HALF_H, z })
    const [tl, tr, br, bl] = [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)]
    expect(tl.y).toBeCloseTo(tr.y, 9)
    expect(bl.y).toBeCloseTo(br.y, 9)
    expect(tl.x).toBeCloseTo(bl.x, 9)
    expect(tr.x).toBeCloseTo(br.x, 9)
  })

  it('palco largo (16:9): a altura limita e a tela ocupa ~94% dela (~10% maior que os 85% de antes)', () => {
    const f = screenFill(16 / 9)
    expect(MONITOR_FILL / 0.85).toBeGreaterThan(1.1)
    expect(f.h).toBeCloseTo(MONITOR_FILL, 1)
    expect(f.h).toBeGreaterThan(0.91)
    expect(f.h).toBeLessThan(0.97)
    expect(f.w).toBeLessThan(f.h)
  })

  it('palco estreito (0.4): a largura limita e a tela cabe com margem', () => {
    const f = screenFill(0.4)
    expect(f.w).toBeGreaterThan(0.91)
    expect(f.w).toBeLessThan(0.97)
    expect(f.h).toBeLessThan(f.w)
  })

  it('com a faixa do HUD (heightPx + clearTopPx): a tela desce para livrar a faixa, não passa do fim e fica maior que a de antes', () => {
    const m = { x: 3, y: 1.12, z: 2 }
    const z = m.z + MONITOR_SCREEN_FRONT
    for (const [w, h] of [
      [1600, 900],
      [1280, 720],
      [1920, 1200],
      [600, 900]
    ]) {
      const aspect = w / h
      const pose = monitorPose(m, { fovDeg: FOV, aspect, heightPx: h, clearTopPx: 56 })
      const px = (y: number): number => ((1 - ndc(pose, aspect, { x: m.x, y, z }).y) / 2) * h
      const top = px(m.y + MONITOR_HALF_H)
      const bottom = px(m.y - MONITOR_HALF_H)
      expect(top).toBeGreaterThanOrEqual(56 - 1)
      expect(bottom).toBeLessThanOrEqual(h - MONITOR_BOTTOM_GAP + 1)
      // Maior que a tela de antes (85% do palco, centrada).
      const before = monitorPose(m, { fovDeg: FOV, aspect }, 0.85)
      expect(pose.distance).toBeLessThan(before.distance)
    }
    // Sem a altura do palco, nada muda: centrada, como antes.
    expect(monitorPose(m, { fovDeg: FOV, aspect: 16 / 9, clearTopPx: 56 }).ty).toBe(m.y)
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
