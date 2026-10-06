import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { createBrain } from './brainBody'
import { createKit } from './kit'
import { MOTION_SLOTS, MotionLibrary, MS, newSample } from './motionLibrary'
import { pickMotion, VARIANT_S, type MotionState } from './motionPick'
import { MotionPlayer, MOTION_FADE_S } from './motionPlayer'
import { BODY, CH, newPose } from './poses'
import { applyPose, buildRig } from './rig'
import { Group } from 'three'

/** Um arquivo de movimentos com os clipes dados (cada um: quadros × a rotação de cada segmento + bacia). */
function file(clips: Array<{ key: string; loop: boolean; frames: Array<{ q?: Partial<Record<string, Quaternion>>; hipsY?: number; curl?: number }> }>, fps = 10): Uint8Array {
  const PER = MOTION_SLOTS.length * 4 + 5
  const chunks: Int16Array[] = []
  const head: Array<{ key: string; frames: number; loop: boolean; offset: number }> = []
  let offset = 0
  for (const c of clips) {
    const d = new Int16Array(c.frames.length * PER)
    c.frames.forEach((f, i) => {
      MOTION_SLOTS.forEach((s, k) => {
        const q = f.q?.[s] ?? new Quaternion()
        d.set([q.x, q.y, q.z, q.w].map((v) => Math.round(v * 32767)), i * PER + k * 4)
      })
      d.set([Math.round((f.hipsY ?? 0) * 1e4), 0, 0, Math.round((f.curl ?? 0) * 32767), Math.round((f.curl ?? 0) * 32767)], i * PER + MOTION_SLOTS.length * 4)
    })
    head.push({ key: c.key, frames: c.frames.length, loop: c.loop, offset })
    offset += d.byteLength
    chunks.push(d)
  }
  const json = new TextEncoder().encode(JSON.stringify({ fps, slots: MOTION_SLOTS, clips: head }))
  const pad = (8 + json.length) % 2
  const out = new Uint8Array(8 + json.length + pad + offset)
  out.set([77, 79, 86, 49])
  new DataView(out.buffer).setUint32(4, json.length, true)
  out.set(json, 8)
  let at = 8 + json.length + pad
  for (const c of chunks) {
    out.set(new Uint8Array(c.buffer), at)
    at += c.byteLength
  }
  return out
}

const turn = (axis: [number, number, number], a: number): Quaternion => new Quaternion().setFromAxisAngle(new Vector3(...axis), a)

describe('motionLibrary', () => {
  it('lê o arquivo e amostra com interpolação (em laço volta ao começo; sem laço para no último quadro)', () => {
    const lib = MotionLibrary.parse(file([{ key: 'a', loop: true, frames: [{ hipsY: 0 }, { hipsY: 0.1, q: { armL: turn([1, 0, 0], 1) } }] }]))!
    expect(lib).not.toBeNull()
    const c = lib.clip('a')!
    expect([c.frames, c.duration]).toEqual([2, 0.2])
    const s = newSample()
    lib.sample(c, 0.05, true, s)
    expect(s.hipsY).toBeCloseTo(0.05, 3)
    expect(s.q[MS.armL].angleTo(new Quaternion())).toBeCloseTo(0.5, 2)
    // Em laço, 0,15 s fica entre o último quadro e o primeiro.
    lib.sample(c, 0.15, true, s)
    expect(s.hipsY).toBeCloseTo(0.05, 3)
    lib.sample(c, 5, false, s)
    expect(s.hipsY).toBeCloseTo(0.1, 3)
  })

  it('formato errado não vira biblioteca', () => {
    expect(MotionLibrary.parse(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]))).toBeNull()
  })
})

describe('motionPick — qual movimento agora', () => {
  const all = (): boolean => true
  const base: MotionState = { action: 'idle', reaction: null, sit: 0, seat: null, speed: 0, prop: null, seed: 0.37, t: 10 }

  it('parado à toa em pé: uma variação de "idle" no corpo inteiro, que troca de tempos em tempos', () => {
    const seen = new Set<string>()
    for (let t = 0; t < VARIANT_S * 12; t += VARIANT_S) seen.add(pickMotion({ ...base, t }, all)!.key)
    expect(seen.size).toBeGreaterThan(2)
    expect(pickMotion(base, all)).toMatchObject({ mask: 'full', loop: true, phase: false })
  })

  it('andando: o passo sincronizado com a fase; com objeto na mão, só as pernas', () => {
    expect(pickMotion({ ...base, action: 'none', speed: 1.1 }, all)).toMatchObject({ mask: 'full', phase: true })
    expect(pickMotion({ ...base, action: 'none', speed: 1.1, prop: 'cup' }, all)).toMatchObject({ mask: 'lower', phase: true })
    expect(pickMotion({ ...base, action: 'none', speed: 3 }, all)!.key).toMatch(/sprint|jog/)
  })

  it('sentado na cadeira: só o tronco e os braços; digitar e cochilar seguem procedurais; no sofá, nada', () => {
    const chair = { ...base, sit: 1, seat: 'chair' }
    expect(pickMotion({ ...chair, action: 'sitIdle' }, all)).toMatchObject({ mask: 'upper', loop: true })
    expect(pickMotion({ ...chair, action: 'type' }, all)).toBeNull()
    expect(pickMotion({ ...chair, action: 'napDesk' }, all)).toBeNull()
    expect(pickMotion({ ...base, sit: 1, seat: 'sofa', action: 'napSofa' }, all)).toBeNull()
    // Sentando ou levantando: o procedural.
    expect(pickMotion({ ...chair, sit: 0.5, action: 'sitIdle' }, all)).toBeNull()
  })

  it('reação passa na frente da ação (uma vez); sentado usa a versão sentada', () => {
    expect(pickMotion({ ...base, reaction: 'celebrate' }, all)).toMatchObject({ loop: false, mask: 'full' })
    const seated = pickMotion({ ...base, sit: 1, seat: 'chair', action: 'type', reaction: 'celebrate' }, all)!
    expect(seated.key).toMatch(/^sit/)
    expect(seated.mask).toBe('upper')
  })

  it('a festa dança; o trenzinho, a lanterna e a pizza seguem procedurais; clipe que falta não é escolhido', () => {
    expect(pickMotion({ ...base, action: 'disco' }, all)!.key).toMatch(/^dance/)
    for (const action of ['conga', 'flashlight', 'pizza'] as const) expect(pickMotion({ ...base, action }, all)).toBeNull()
    expect(pickMotion({ ...base, action: 'robot' }, (k) => k === 'danceTut')!.key).toBe('danceTut')
    expect(pickMotion({ ...base, action: 'robot' }, () => false)).toBeNull()
  })
})

describe('motionPlayer — o clipe nas juntas do boneco', () => {
  const lib = MotionLibrary.parse(
    file([
      { key: 'idleBreath', loop: true, frames: [{ q: { armL: turn([0, 0, 1], -Math.PI / 2), hips: turn([0, 1, 0], 0.3) }, hipsY: -0.1, curl: 0.8 }] },
      { key: 'sitIdle', loop: true, frames: [{ q: { armR: turn([1, 0, 0], 1.2), legL: turn([1, 0, 0], 0.7) } }] }
    ])
  )!

  function setup(): { rig: ReturnType<typeof buildRig>; kit: ReturnType<typeof createKit>; player: MotionPlayer } {
    const kit = createKit(1)
    const rig = buildRig(kit, new Group(), { skin: kit.mat.eye, shirt: kit.mat.eye, hair: kit.mat.eye, pants: kit.mat.eye })
    return { rig, kit, player: new MotionPlayer(() => lib) }
  }
  const world = (g: { getWorldQuaternion(q: Quaternion): Quaternion }): Quaternion => g.getWorldQuaternion(new Quaternion())

  it('entra em MOTION_FADE_S e o braço chega na rotação do clipe (no referencial do personagem); a bacia gira e desce', () => {
    const { rig, kit, player } = setup()
    const b = createBrain({ key: 'k', role: 'visitor', roomId: 'office', home: { x: 0, z: 0, yaw: 0 } })
    const p = newPose()
    const frame = (dt: number): void => {
      p.fill(0)
      player.before(dt, b, 1, 0, p, BODY, false, rig)
      applyPose(rig, p, 1, 0)
      player.joints(rig)
      rig.pelvis.parent!.updateMatrixWorld(true)
    }
    frame(MOTION_FADE_S / 2)
    expect(player.weight).toBeCloseTo(0.5, 2)
    for (let i = 0; i < 4; i++) frame(MOTION_FADE_S / 2)
    expect(player.key).toBe('idleBreath')
    expect(player.weight).toBe(1)
    expect(world(rig.shoulderL).angleTo(turn([0, 0, 1], -Math.PI / 2))).toBeLessThan(1e-3)
    expect(world(rig.pelvis).angleTo(turn([0, 1, 0], 0.3))).toBeLessThan(1e-3)
    expect(p[CH.pelvisY]).toBeCloseTo(-0.1 * (BODY.ankleY + BODY.thigh + BODY.shin), 3)
    expect(p[CH.fingersL]).toBeCloseTo(0.8, 2)
    kit.dispose()
  })

  it('sentado: só o tronco e os braços — a perna fica a do assento; ao sair, as juntas voltam ao procedural', () => {
    const { rig, kit, player } = setup()
    const b = createBrain({ key: 'k', role: 'visitor', roomId: 'office', home: { x: 0, z: 0, yaw: 0 } })
    Object.assign(b, { sit: 1, seat: 'chair', action: 'sitIdle' })
    const p = newPose()
    const frame = (dt: number): void => {
      p.fill(0)
      p[CH.legL] = 1.4
      player.before(dt, b, 1, 0, p, BODY, false, rig)
      applyPose(rig, p, 1, 0)
      player.joints(rig)
    }
    for (let i = 0; i < 6; i++) frame(MOTION_FADE_S / 2)
    expect(player.mask).toBe('upper')
    expect(rig.shoulderR.quaternion.angleTo(turn([1, 0, 0], 1.2))).toBeLessThan(1e-3)
    expect(rig.legL.quaternion.angleTo(turn([1, 0, 0], 1.4))).toBeLessThan(1e-3)
    // Digitando (procedural): o clipe sai e as juntas voltam ao que o applyPose põe.
    b.action = 'type'
    for (let i = 0; i < 6; i++) frame(MOTION_FADE_S / 2)
    expect(player.weight).toBe(0)
    frame(0.016)
    expect(rig.elbowR.rotation.y).toBe(0)
    expect(rig.pelvis.quaternion.angleTo(new Quaternion())).toBe(0)
    kit.dispose()
  })
})
