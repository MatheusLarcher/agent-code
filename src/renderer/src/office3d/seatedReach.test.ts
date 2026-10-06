/**
 * Ergonomia de quem senta na estação (o assento no padrão, a mesa como está): o boneco (BODY, inteiro e o menor,
 * 0,85) e cada avatar do elenco (resources/office-agents, aberto sem o GLTFLoader — testGlb.ts — e preparado pelo
 * prepareAvatar: `fit` e `metrics`). Digitando ('type' e 'typeFast', pela MESMA conta do typing: reach.typingArm),
 * o punho chega ao teclado com o cotovelo dobrado e o antebraço quase na horizontal; sentado (sitLower), o quadril
 * fica acima do assento, o joelho abaixo da face de baixo do tampo e a ponta do pé no chão.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareAvatar } from './agentRest'
import { DESK_HEIGHT } from './officePlan'
import { BODY, CH, newPose, SEAT_HEIGHT, sitLower, type BodyMetrics } from './poses'
import { DESK_TOP, REACH_SLACK, typingArm } from './reach'
import { AGENTS_DIR, buildScene, readGlb } from './testGlb'

const ROLES = ['principal', 'executor', 'critico', 'navegador-de-codigo', 'memoria', 'po', 'vigia', 'subagente', 'central']
/** A inclinação do tronco de cada ação de digitar (gestures.ts). */
const LEANS: Record<string, number> = { type: 0.1, typeFast: 0.16 }
const DEG = Math.PI / 180

const bodies: Array<{ name: string; scale: number; b: BodyMetrics }> = [
  { name: 'boneco', scale: 1, b: BODY },
  { name: 'boneco 0,85', scale: 0.85, b: BODY }
]
for (const role of ROLES) {
  const path = join(AGENTS_DIR, `${role}.glb`)
  if (!existsSync(path)) continue
  const { json, bin } = readGlb(path)
  const t = prepareAvatar(buildScene(json, bin).scene)
  if (typeof t === 'string') throw new Error(`prepareAvatar recusou ${role}: ${t}`)
  bodies.push({ name: role, scale: t.fit, b: t.metrics })
}

describe('ergonomia sentado na estação', () => {
  it('as medidas no padrão: assento 0,42–0,52 m (NBR 13962) e tampo 0,72–0,78 m', () => {
    expect(SEAT_HEIGHT.chair).toBeGreaterThanOrEqual(0.42)
    expect(SEAT_HEIGHT.chair).toBeLessThanOrEqual(0.52)
    expect(DESK_TOP).toBeGreaterThanOrEqual(0.72)
    expect(DESK_TOP).toBeLessThanOrEqual(0.78)
  })

  it.each(bodies)('$name: digitando, o punho chega ao teclado sem esticar o braço e o antebraço fica a ±20° da horizontal', ({ scale, b }) => {
    for (const [action, lean] of Object.entries(LEANS)) {
      const r = typingArm(lean, scale, b)
      expect(r.slack, `${action}: folga do braço`).toBeGreaterThanOrEqual(REACH_SLACK - 1e-6)
      expect(Math.abs(r.forearm) / DEG, `${action}: antebraço (graus)`).toBeLessThanOrEqual(20)
    }
  })

  it.each(bodies)('$name: sentado, o quadril fica acima do assento, o joelho abaixo do tampo e o pé apoiado no chão (calcanhar e ponta)', ({ scale, b }) => {
    // Cada um senta do seu jeito (vary) e de tempos em tempos troca o apoio (t): o pé fica no chão em todos.
    for (const vary of [0, 0.5, 1]) {
      for (const t of [0, 3, 7, 13, 20]) {
        const p = newPose()
        sitLower(p, 'chair', t, scale, vary, b)
        // Em medidas do modelo (o personagem inteiro vai × scale): a junta do quadril, o joelho e o tornozelo.
        const hip = b.pelvisY + p[CH.pelvisY] - b.hipDrop
        expect(hip * scale).toBeGreaterThan(SEAT_HEIGHT.chair)
        for (const [leg, knee, foot] of [[CH.legL, CH.kneeL, CH.footL], [CH.legR, CH.kneeR, CH.footR]] as const) {
          const at = `vary ${vary}, t ${t}`
          const kneeY = hip - b.thigh * Math.cos(p[leg])
          const ankleY = kneeY - b.shin * Math.cos(p[leg] - p[knee])
          // O joelho com a carne em volta (5 cm) cabe sob o tampo.
          expect(kneeY * scale + 0.05, `${at}: joelho`).toBeLessThan(DESK_HEIGHT - 0.025)
          // O calcanhar no chão (o tornozelo na altura de em pé) e a sola reta: nada de ponta do pé.
          expect(Math.abs(ankleY - b.ankleY) * scale, `${at}: calcanhar`).toBeLessThan(0.005)
          expect(Math.abs(p[foot]), `${at}: sola`).toBeLessThan(0.02)
        }
      }
    }
  })
})
