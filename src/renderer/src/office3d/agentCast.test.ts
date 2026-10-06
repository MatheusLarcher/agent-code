/**
 * Os avatares GLB de verdade (resources/office-agents/<papel>.glb, gerados pelo
 * pipeline de scripts/office-agents). Cada arquivo que existe é aberto SEM o
 * GLTFLoader (testGlb.ts) e o prepareAvatar do app (agentRest.ts) prepara o
 * esqueleto como no escritório. Confere a malha com pele, os ossos pelo
 * mapBones, a máscara de tingimento (textura de metal/rugosidade +
 * tintMeanLuma), o tamanho, a altura de bind da ficha e medidas plausíveis de
 * pernas e braços.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapBones } from './agentBones'
import { prepareAvatar } from './agentRest'
import { AGENTS_DIR as DIR, bindHeight, buildScene, readGlb } from './testGlb'

/** Teto do arquivo de cada avatar (o instalador leva todos). */
const MAX_BYTES = 4 * 1024 * 1024

/** Papel → altura da ficha no bind (m) e se a roupa principal é tingível (a Central não tem máscara). */
const CAST: ReadonlyArray<{ role: string; height: number; tint: boolean }> = [
  { role: 'executor', height: 1.66, tint: true },
  { role: 'critico', height: 1.78, tint: true },
  { role: 'navegador-de-codigo', height: 1.63, tint: true },
  { role: 'memoria', height: 1.62, tint: true },
  { role: 'po', height: 1.66, tint: true },
  { role: 'vigia', height: 1.88, tint: true },
  { role: 'subagente', height: 1.72, tint: true },
  { role: 'principal', height: 1.83, tint: true },
  { role: 'central', height: 1.75, tint: false }
]

for (const { role, height, tint } of CAST) {
  const path = join(DIR, `${role}.glb`)
  describe.runIf(existsSync(path))(`avatar ${role}.glb`, () => {
    it('cabe no instalador e tem UMA malha com pele, com os ossos que o app move', () => {
      expect(statSync(path).size).toBeLessThanOrEqual(MAX_BYTES)
      const { json, bin } = readGlb(path)
      const { skinned, jointNames } = buildScene(json, bin)
      expect(skinned).toHaveLength(1)
      const map = mapBones(jointNames)
      expect(map.missing).toEqual([])
      // Rig do Mixamo vem com dedos (a mão fecha); o do Meshy não tem.
      if (map.flavor === 'mixamo') expect(map.fingers).toBe(true)
    })

    it.runIf(tint)('traz a máscara da roupa: textura de metal/rugosidade e a luma média da roupa', () => {
      const { json } = readGlb(path)
      const node = json.nodes.find((n) => n.mesh !== undefined && n.skin !== undefined)!
      const mat = json.materials![json.meshes[node.mesh!].primitives[0].material ?? 0]
      expect(mat.pbrMetallicRoughness?.metallicRoughnessTexture).toBeDefined()
      const luma = mat.extras?.tintMeanLuma
      expect(typeof luma).toBe('number')
      expect(luma!).toBeGreaterThan(0)
      expect(luma!).toBeLessThan(1)
    })

    it('fica na altura da ficha e o prepareAvatar aceita, com pernas e braços de gente', () => {
      const { json, bin } = readGlb(path)
      const { scene } = buildScene(json, bin)
      expect(bindHeight(json, bin, scene)).toBeCloseTo(height, 1)
      const t = prepareAvatar(scene)
      if (typeof t === 'string') throw new Error(`prepareAvatar recusou ${role}: ${t}`)
      const m = t.metrics
      // Depois da escala pelas pernas (agentRest.legScale), em metros do boneco.
      expect(m.thigh).toBeGreaterThan(0.3)
      expect(m.thigh).toBeLessThan(0.6)
      expect(m.shin).toBeGreaterThan(0.3)
      expect(m.shin).toBeLessThan(0.6)
      expect(m.upperArm).toBeGreaterThan(0.15)
      expect(m.upperArm).toBeLessThan(0.4)
      expect(m.forearm).toBeGreaterThan(0.15)
      expect(m.forearm).toBeLessThan(0.4)
      // Braço (ombro → pulso) entre metade e 90% da perna (quadril → tornozelo).
      const arm = (m.upperArm + m.forearm) / (m.thigh + m.shin)
      expect(arm).toBeGreaterThan(0.5)
      expect(arm).toBeLessThan(0.9)
      expect(m.shoulderX).toBeGreaterThan(0.08)
      expect(m.shoulderX).toBeLessThan(0.3)
      expect(m.pelvisY).toBeGreaterThan(0.85)
      expect(m.pelvisY).toBeLessThan(1.2)
      expect(m.headH).toBeGreaterThan(0.05)
      expect(m.headH).toBeLessThan(0.2)
    })
  })
}
