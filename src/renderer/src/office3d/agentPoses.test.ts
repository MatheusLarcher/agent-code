import { Color } from 'three'
import { describe, expect, it } from 'vitest'
import { metricsFromSkeleton } from './agentMetrics'
import { agentMaterial, MIN_ROUGHNESS, patchTintShader } from './agentTint'
import { seedColor } from './appearance'
import { CH, locomotion, newPose, SEAT_HEIGHT, sitLower, strideLength, type BodyMetrics, type Pose } from './poses'
import { headLocal } from './rig'
import { MeshStandardMaterial } from 'three'

/** As medidas do v1 (cartoon: pernas curtas, cabeça grande). */
const V1: BodyMetrics = metricsFromSkeleton(
  {
    hips: [0, 0.953, 0], upLegL: [-0.102, 0.862, 0], upLegR: [0.102, 0.862, 0], legL: [-0.102, 0.497, 0], footL: [-0.102, 0.145, 0],
    armL: [-0.217, 1.357, 0], armR: [0.217, 1.357, 0], forearmL: [-0.217, 1.11, 0], handL: [-0.217, 0.859, 0],
    head: [0, 1.51, 0], headTop: [0, 1.83, 0], toe: [-0.102, 0.03, -0.12], toeIsBase: true
  },
  0.149
)

/** Tornozelo do lado `L` com as medidas `b` (como o adaptador posa o modelo). */
function ankle(p: Pose, b: BodyMetrics): { x: number; y: number } {
  const hipY = b.pelvisY + p[CH.pelvisY] + p[CH.hop] - b.hipDrop
  return {
    x: b.thigh * Math.sin(p[CH.legL]) + b.shin * Math.sin(p[CH.legL] - p[CH.kneeL]),
    y: hipY - b.thigh * Math.cos(p[CH.legL]) - b.shin * Math.cos(p[CH.legL] - p[CH.kneeL])
  }
}

describe('poses com as medidas do modelo (BodyMetrics)', () => {
  it('andando, o pé de apoio fica no chão (altura do tornozelo do modelo) e não desliza', () => {
    const stride = strideLength(0, V1)
    const p = newPose()
    const xs: number[] = []
    for (let k = 0; k <= 200; k++) {
      const d = (k / 200) * stride
      locomotion(p, d / stride, 1, 0, V1)
      const a = ankle(p, V1)
      // No 1º apoio (pé no chão, até 60% do ciclo) o tornozelo recua exatamente o que o corpo andou.
      if (k < 115 && Math.abs(a.y - V1.ankleY) < 1e-4) xs.push(a.x + d)
      expect(a.y).toBeGreaterThanOrEqual(V1.ankleY - 1e-4)
    }
    expect(xs.length).toBeGreaterThan(50)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-3)
  })

  it('na cadeira, a bacia fica na altura do assento (não flutua nem afunda) e o pé fica apoiado no chão, mesmo com as pernas curtas do v1', () => {
    const p = newPose()
    sitLower(p, 'chair', 0, 1, 0.5, V1)
    const hipJoint = V1.pelvisY + p[CH.pelvisY] - V1.hipDrop
    expect(hipJoint).toBeCloseTo(SEAT_HEIGHT.chair + 0.09, 3)
    // A ponta do pé (sola + avanço) e o calcanhar (o tornozelo na altura da sola) no chão: a sola inteira apoiada.
    const a = ankle(p, V1)
    const toeY = a.y - Math.hypot(V1.soleDown, V1.toeAhead) * Math.sin(-p[CH.footL] + Math.atan2(V1.soleDown, V1.toeAhead))
    expect(Math.abs(toeY)).toBeLessThan(0.005)
    expect(Math.abs(a.y - V1.ankleY)).toBeLessThan(0.005)
  })

  it('a cabeça do HUD sai das medidas do modelo', () => {
    const p = newPose()
    const out = { x: 0, y: 0, z: 0 }
    headLocal(p, out, V1)
    expect(out.y).toBeCloseTo(V1.pelvisY + V1.headY * Math.cos(p[CH.lean]), 3)
    expect(out.y).toBeGreaterThan(1.6)
    expect(out.y).toBeLessThan(1.75)
  })
})

describe('tingimento da roupa', () => {
  it('a cor do material é a seedColor do agente (a mesma do chat)', () => {
    const base = new MeshStandardMaterial()
    base.userData.tintMeanLuma = 0.1
    const m = agentMaterial(base, seedColor('conv-123'), null)
    const u = m.userData.tint as { tintColor: { value: Color }; tintLuma: { value: number } }
    expect(u.tintColor.value.equals(seedColor('conv-123'))).toBe(true)
    expect(u.tintColor.value.equals(seedColor('outra'))).toBe(false)
    expect(u.tintLuma.value).toBe(0.1)
    // Cada agente tem o próprio uniform, mas todos dividem o programa do shader.
    const n = agentMaterial(base, seedColor('outra'), null)
    expect(n.customProgramCacheKey()).toBe(m.customProgramCacheKey())
    expect(n.userData.tint).not.toBe(m.userData.tint)
  })

  it('o shader lê a máscara do canal R da metal/rugosidade e limita o brilho', () => {
    const src = 'void main() {\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>\n}'
    const out = patchTintShader(src)
    expect(out).toContain('uniform vec3 tintColor;')
    expect(out).toContain('texture2D( roughnessMap, vRoughnessMapUv ).r')
    expect(out).toContain(`roughnessFactor = max( roughnessFactor, ${MIN_ROUGHNESS.toFixed(3)} )`)
    expect(out.indexOf('tintMask')).toBeGreaterThan(out.indexOf('#include <map_fragment>'))
  })
})
