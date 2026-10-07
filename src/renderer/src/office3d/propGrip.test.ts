/**
 * Objeto na mão: em que nível cada um aparece (propShown, a marca de LOD de makeProp), a xícara de pé no
 * mundo pendurada pela alça seja qual for o giro da mão (holdCup) e o encaixe na mão do
 * avatar GLB — o socketR na escala do boneco, com a xícara do tamanho de uma xícara (o Mixamo vem em
 * centímetros; sem desfazer a escala do osso ela virava 1 mm).
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Box3, Group, Object3D, Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { prepareAvatar } from './agentRest'
import type { PropKind } from './brain'
import { pickMotion } from './motionPick'
import { createPropKit, CUP_HANDLE, GRIP_AVATAR, holdCup, makeProp, propShown } from './props'
import { AGENTS_DIR, buildScene, readGlb } from './testGlb'

const KINDS: PropKind[] = ['cup', 'book', 'can', 'phone', 'folder', 'sign', 'note', 'flashlight', 'pizza']

describe('objeto na mão por nível', () => {
  it('PERTO todos; MÉDIO a plaquinha, a lanterna e a xícara; LONGE nenhum', () => {
    for (const k of KINDS) {
      expect(propShown(k, 0)).toBe(true)
      expect(propShown(k, 1)).toBe(k === 'sign' || k === 'flashlight' || k === 'cup')
      expect(propShown(k, 2)).toBe(false)
    }
  })

  it('a marca de LOD bate: a xícara some só no LONGE, os outros pequenos no MÉDIO', () => {
    const kit = createPropKit()
    const tag = (k: PropKind): unknown => makeProp(kit, k).userData.lod
    expect(tag('cup')).toBe('small')
    expect(tag('book')).toBe('detail')
    expect(tag('sign')).toBeUndefined()
    expect(tag('flashlight')).toBeUndefined()
    kit.dispose()
  })
})

describe('xícara de pé no mundo, pendurada pela alça (holdCup)', () => {
  it('com a mão girada em qualquer eixo (clipe do Mixamo): de pé, alça no encaixe e para trás; o gole inclina para o rosto', () => {
    const body = new Group()
    body.rotation.y = 0.8
    const arm = new Object3D()
    arm.rotation.set(-1.1, 0.4, 0.9)
    const hand = new Object3D()
    hand.rotation.set(0.3, -1.2, 0.5)
    const cup = new Object3D()
    cup.userData.grip = [-0.03, -0.1, 0.01]
    body.add(arm)
    arm.add(hand)
    hand.add(cup)
    const world = (v: Vector3): Vector3 => v.applyQuaternion(cup.getWorldQuaternion(new Quaternion()))
    // Do mundo para o referencial do personagem (desfaz o rumo).
    const local = (v: Vector3): Vector3 => v.applyAxisAngle(new Vector3(0, 1, 0), -0.8)
    holdCup(cup, body, 0)
    cup.updateWorldMatrix(true, false)
    expect(world(new Vector3(0, 1, 0)).y).toBeCloseTo(1, 5)
    const handle = local(world(new Vector3(1, 0, 0)))
    expect(handle.z).toBeCloseTo(1, 5)
    const atGrip = cup.localToWorld(CUP_HANDLE.clone()).distanceTo(hand.localToWorld(new Vector3(-0.03, -0.1, 0.01)))
    expect(atGrip).toBeCloseTo(0, 5)
    // Gole: a boca da xícara vai para +Z do personagem (o rosto de quem bebe).
    holdCup(cup, body, 0.9)
    cup.updateWorldMatrix(true, false)
    const up = local(world(new Vector3(0, 1, 0)))
    expect(up.y).toBeCloseTo(Math.cos(0.9), 5)
    expect(up.z).toBeCloseTo(Math.sin(0.9), 5)
  })
})

describe('o gole com a xícara na direita', () => {
  it('é o procedural (os clipes drink/sitDrink bebem com a esquerda); sem objeto o clipe continua', () => {
    const base = { action: 'sip' as const, reaction: null, speed: 0, seed: 0.2, t: 3 }
    const has = (): boolean => true
    expect(pickMotion({ ...base, sit: 0, seat: null, prop: 'cup' }, has)).toBeNull()
    expect(pickMotion({ ...base, sit: 1, seat: 'chair', prop: 'cup' }, has)).toBeNull()
    expect(pickMotion({ ...base, sit: 0, seat: null, prop: null }, has)?.key).toBe('drink')
  })
})

const ROLES = ['principal', 'executor', 'critico', 'navegador-de-codigo', 'memoria', 'po', 'vigia', 'subagente', 'central']
for (const role of ROLES) {
  const path = join(AGENTS_DIR, `${role}.glb`)
  describe.runIf(existsSync(path))(`encaixe da mão: ${role}.glb`, () => {
    it('o socketR está na escala do boneco e a xícara fica com ~9 cm, a alça a ~10 cm do pulso', () => {
      const { json, bin } = readGlb(path)
      const t = prepareAvatar(buildScene(json, bin).scene)
      if (typeof t === 'string') throw new Error(`prepareAvatar recusou ${role}: ${t}`)
      const socket = t.root.getObjectByName('avatar:socketR')!
      const kit = createPropKit()
      const cup = makeProp(kit, 'cup')
      socket.add(cup)
      cup.userData.grip = GRIP_AVATAR.cup
      holdCup(cup, t.root, 0)
      t.root.updateMatrixWorld(true)
      expect(socket.getWorldScale(new Vector3()).x).toBeCloseTo(1, 3)
      const size = new Box3().setFromObject(cup).getSize(new Vector3())
      expect(size.y).toBeCloseTo(0.09, 2)
      // O encaixe (GRIP_AVATAR) em metros do boneco: a alça nos dedos, a uns 10 cm do pulso.
      const d = cup.localToWorld(CUP_HANDLE.clone()).distanceTo(socket.getWorldPosition(new Vector3()))
      expect(d).toBeCloseTo(Math.hypot(...GRIP_AVATAR.cup), 3)
      kit.dispose()
    })
  })
}
