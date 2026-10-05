/**
 * Medidas do corpo de um modelo GLB — PURO (sem three): lidas das juntas do
 * esqueleto já na pose de repouso alinhada (pernas e braços retos para baixo,
 * agentAvatar.ts), no referencial do personagem (m, Y para cima). Saem no
 * formato de BODY (poses.ts), que poses, gestos e o HUD leem no lugar dele.
 */
import { BODY, type BodyMetrics } from './poses'

export type Vec3 = readonly [number, number, number]

export interface SkeletonPoints {
  hips: Vec3
  upLegL: Vec3
  upLegR: Vec3
  legL: Vec3
  footL: Vec3
  armL: Vec3
  armR: Vec3
  forearmL: Vec3
  handL: Vec3
  head: Vec3
  /** Topo da cabeça (HeadTop_End/head_end); sem ele, a cabeça do BODY na escala do modelo. */
  headTop: Vec3 | null
  /** Ponta do pé (Toe_End) ou a base dos dedos (ToeBase); null sem nenhum. */
  toe: Vec3 | null
  /** `toe` é a base dos dedos (falta o Toe_End): a ponta fica mais à frente. */
  toeIsBase: boolean
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * Medidas pelo esqueleto. `soleDown` = quanto o tornozelo fica acima da sola
 * com o pé no chão (na pose de bind, osso do pé menos o ponto mais baixo da malha).
 */
export function metricsFromSkeleton(s: SkeletonPoints, soleDown: number): BodyMetrics {
  const thigh = dist(s.upLegL, s.legL)
  const shin = dist(s.legL, s.footL)
  const hipDrop = Math.max(0, s.hips[1] - (s.upLegL[1] + s.upLegR[1]) / 2)
  const ankleY = soleDown
  const headH = s.headTop ? Math.max(0.05, (s.headTop[1] - s.head[1]) / 2) : BODY.headH
  const headCenter = s.head[1] + headH
  const toeRun = s.toe ? Math.hypot(s.toe[0] - s.footL[0], s.toe[2] - s.footL[2]) * (s.toeIsBase ? 1.6 : 1) : BODY.toeAhead
  // Altura do pivô com as pernas esticadas na vertical (é o que as poses supõem em pé).
  const pelvisY = ankleY + thigh + shin + hipDrop
  const k = headH / BODY.headH
  return {
    ankleY,
    thigh,
    shin,
    hipDrop,
    hipX: Math.abs(s.upLegL[0] - s.upLegR[0]) / 2,
    pelvisY,
    shoulderY: (s.armL[1] + s.armR[1]) / 2 - s.hips[1],
    shoulderX: Math.abs(s.armL[0] - s.armR[0]) / 2,
    headY: headCenter - s.hips[1],
    headW: BODY.headW * k,
    headH,
    headD: BODY.headD * k,
    upperArm: dist(s.armL, s.forearmL),
    forearm: dist(s.forearmL, s.handL),
    soleDown: ankleY,
    toeAhead: Math.max(0.08, toeRun)
  }
}
