import { describe, expect, it } from 'vitest'
import { mapBones, normBone, REQUIRED, rigFlavor } from './agentBones'
import { metricsFromSkeleton } from './agentMetrics'
import { BODY } from './poses'

/** Os 65 ossos do Mixamo (Skeleton LOD Standard, com dedos), como o GLTFLoader deixa (sem o ":"). */
function mixamoNames(prefix = 'mixamorig'): string[] {
  const n = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End']
  for (const s of ['Left', 'Right']) {
    n.push(`${s}Shoulder`, `${s}Arm`, `${s}ForeArm`, `${s}Hand`, `${s}UpLeg`, `${s}Leg`, `${s}Foot`, `${s}ToeBase`, `${s}Toe_End`)
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (const k of [1, 2, 3, 4]) n.push(`${s}Hand${f}${k}`)
  }
  return n.map((x) => prefix + x)
}

/** Os 24 ossos do Meshy (sem dedos; a coluna numerada ao contrário e "neck" minúsculo). */
const MESHY = [
  'Hips', 'Spine02', 'Spine01', 'Spine', 'neck', 'Head', 'head_end', 'headfront', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'
]

describe('agentBones: nomes dos ossos', () => {
  it('tira o prefixo do Mixamo com ou sem ":" e número', () => {
    expect(normBone('mixamorig:LeftHandIndex1')).toBe('lefthandindex1')
    expect(normBone('mixamorigLeftHandIndex1')).toBe('lefthandindex1')
    expect(normBone('mixamorig1:Hips')).toBe('hips')
    expect(normBone('mixamorig_Spine2')).toBe('spine2')
    expect(normBone('neck')).toBe('neck')
  })

  it('Mixamo: liga coluna, braços, pernas e os dedos; nada obrigatório falta', () => {
    for (const prefix of ['mixamorig', 'mixamorig:', 'mixamorig1:']) {
      const m = mapBones(mixamoNames(prefix))
      expect(m.flavor).toBe('mixamo')
      expect(m.missing).toEqual([])
      expect(m.fingers).toBe(true)
      expect(m.bones.spine0).toBe(`${prefix}Spine`)
      expect(m.bones.spine2).toBe(`${prefix}Spine2`)
      expect(m.bones.headTop).toBe(`${prefix}HeadTop_End`)
      expect(m.bones.index3R).toBe(`${prefix}RightHandIndex3`)
      expect(m.bones.thumb1L).toBe(`${prefix}LeftHandThumb1`)
      expect(m.bones.toeEndL).toBe(`${prefix}LeftToe_End`)
      // A 4ª falange (ponta) não move nada: fica de fora.
      expect(Object.values(m.bones)).not.toContain(`${prefix}LeftHandIndex4`)
    }
  })

  it('Meshy: a coluna é invertida (Spine02 embaixo) e não há dedos', () => {
    expect(rigFlavor(MESHY)).toBe('meshy')
    const m = mapBones(MESHY)
    expect(m.missing).toEqual([])
    expect(m.fingers).toBe(false)
    expect(m.bones.spine0).toBe('Spine02')
    expect(m.bones.spine1).toBe('Spine01')
    expect(m.bones.spine2).toBe('Spine')
    expect(m.bones.neck).toBe('neck')
    expect(m.bones.headTop).toBe('head_end')
  })

  it('esqueleto sem as juntas que andam e sentam é recusado', () => {
    const m = mapBones(MESHY.filter((n) => n !== 'LeftLeg' && n !== 'RightHand'))
    expect(m.missing).toEqual(['handR', 'legL'])
    expect(REQUIRED).toContain('legL')
  })
})

describe('agentMetrics: medidas do corpo pelo esqueleto', () => {
  // O v1 do Meshy (1,83 m), juntas medidas no rig (agentRest alinha as pernas na vertical).
  const v1 = metricsFromSkeleton(
    {
      hips: [0, 0.953, 0], upLegL: [-0.102, 0.862, 0], upLegR: [0.102, 0.862, 0], legL: [-0.102, 0.497, 0], footL: [-0.102, 0.145, 0],
      armL: [-0.217, 1.357, 0], armR: [0.217, 1.357, 0], forearmL: [-0.217, 1.11, 0], handL: [-0.217, 0.859, 0],
      head: [0, 1.51, 0], headTop: [0, 1.83, 0], toe: [-0.102, 0.03, -0.12], toeIsBase: true
    },
    0.149
  )

  it('lê coxa, canela, braço e antebraço do esqueleto (não do BODY)', () => {
    expect(v1.thigh).toBeCloseTo(0.365, 3)
    expect(v1.shin).toBeCloseTo(0.352, 3)
    expect(v1.upperArm).toBeCloseTo(0.247, 3)
    expect(v1.forearm).toBeCloseTo(0.251, 3)
    expect(v1.thigh).not.toBeCloseTo(BODY.thigh, 2)
  })

  it('bacia em pé = tornozelo + perna esticada + queda do quadril; ombro e cabeça acima da bacia', () => {
    expect(v1.hipDrop).toBeCloseTo(0.091, 3)
    expect(v1.pelvisY).toBeCloseTo(0.149 + 0.365 + 0.352 + 0.091, 3)
    expect(v1.shoulderY).toBeCloseTo(1.357 - 0.953, 3)
    expect(v1.headH).toBeCloseTo(0.16, 3)
    expect(v1.headY).toBeCloseTo(1.51 + 0.16 - 0.953, 3)
    expect(v1.hipX).toBeCloseTo(0.102, 3)
    expect(v1.shoulderX).toBeCloseTo(0.217, 3)
  })

  it('o pé: sola pelo bind e a ponta à frente do tornozelo (base dos dedos estica 1,6×)', () => {
    expect(v1.soleDown).toBe(0.149)
    expect(v1.ankleY).toBe(0.149)
    expect(v1.toeAhead).toBeCloseTo(0.12 * 1.6, 3)
  })

  it('sem o topo da cabeça usa a do BODY', () => {
    const m = metricsFromSkeleton(
      {
        hips: [0, 1, 0], upLegL: [-0.1, 0.95, 0], upLegR: [0.1, 0.95, 0], legL: [-0.1, 0.5, 0], footL: [-0.1, 0.08, 0], armL: [-0.2, 1.45, 0],
        armR: [0.2, 1.45, 0], forearmL: [-0.2, 1.16, 0], handL: [-0.2, 0.9, 0], head: [0, 1.6, 0], headTop: null, toe: null, toeIsBase: false
      },
      0.08
    )
    expect(m.headH).toBe(BODY.headH)
    expect(m.toeAhead).toBe(BODY.toeAhead)
  })
})
