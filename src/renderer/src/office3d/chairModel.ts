/**
 * A cadeira de escritório do mockup (escritorio-studio, scene.js `chair`) com o
 * assento na altura padrão (SEAT_TOP, NBR 13962): assento 0,64 × 0,62, encosto
 * 0,62 × 0,64 inclinado com o topo ~0,6 m acima do assento, braços ~0,2 m acima
 * dele em ±0,34 (abaixo do tampo da mesa), coluna a gás do cubo até o estofado e
 * base de 5 pés com rodízios no raio de 0,37. Tudo o que fica acima da base sai
 * de SEAT_TOP: mudar o assento leva o encosto, os braços e a coluna juntos.
 *
 * Duas geometrias fundidas no referencial de QUEM SENTA (origem = o quadril,
 * olhando para −Z): o estofado (assento e encosto) e o metal (coluna, base,
 * rodízios, suporte do encosto e braços). O centro da cadeira fica CHAIR_CENTER_Z
 * à frente do quadril: sentado no fundo do assento, as costas no encosto.
 */
import { BoxGeometry, CylinderGeometry, Object3D, type BufferGeometry } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { SEAT_HEIGHT } from './poses'

/** Topo do assento (m): o almofadado do mockup, 0,14 de altura. */
export const SEAT_TOP = SEAT_HEIGHT.chair
/** Centro do encosto e do apoio dos braços (m); o topo do apoio fica abaixo da face de baixo do tampo. */
export const BACK_CENTER_Y = SEAT_TOP + 0.29
export const ARM_Y = SEAT_TOP + 0.205
export const ARM_TOP = ARM_Y + 0.0225
/** Centro da cadeira em relação ao quadril de quem senta (para a frente, −Z). */
export const CHAIR_CENTER_Z = -0.055
/** A inclinação do encosto do mockup (rotation.x = −0,12: o alto dele vem um pouco para a frente). */
export const BACK_TILT = -0.12
/** Meia largura com os braços e raio da base com os rodízios (obstáculo, recuo). */
export const CHAIR_HALF_W = 0.37
export const CHAIR_BASE_R = 0.42

const dummy = new Object3D()

function placed(src: BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0): BufferGeometry {
  dummy.position.set(x, y, z + CHAIR_CENTER_Z)
  dummy.rotation.set(rx, ry, 0)
  dummy.scale.set(1, 1, 1)
  dummy.updateMatrix()
  const g = src.index ? src.toNonIndexed() : src.clone()
  src.dispose()
  // Posição, normal e uv: o mesmo conjunto da fusão da zona (decorUtil.mergeStatic), senão o grupo some.
  for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name)
  return g.applyMatrix4(dummy.matrix)
}

/** O box() do mockup: arredondado (RoundedBoxGeometry) quando tem raio, caixa reta sem. */
const rbox = (w: number, h: number, d: number, r: number, x: number, y: number, z: number, rx = 0, ry = 0): BufferGeometry =>
  // Nas peças finas (raio de 1–2 cm) um segmento dá o mesmo desenho com um quarto dos triângulos.
  placed(r ? new RoundedBoxGeometry(w, h, d, r > 0.03 ? 2 : 1, r) : new BoxGeometry(w, h, d), x, y, z, rx, ry)
/** O cylinder() do mockup (16 lados por padrão), deitado em Z quando `rz`. */
const cyl = (rt: number, rb: number, h: number, x: number, y: number, z: number, seg = 16, rz = 0): BufferGeometry => {
  const g = new CylinderGeometry(rt, rb, h, seg)
  if (rz) g.rotateZ(rz)
  return placed(g, x, y, z)
}

function fuse(parts: BufferGeometry[]): BufferGeometry {
  const g = mergeGeometries(parts, false)!
  for (const p of parts) p.dispose()
  return g
}

/** O estofado e o metal da cadeira, peça por peça como o chair() do mockup (o chamador libera). */
export function officeChairGeometries(): { top: BufferGeometry; base: BufferGeometry } {
  const top = fuse([
    rbox(0.64, 0.14, 0.62, 0.065, 0, SEAT_TOP - 0.07, 0),
    rbox(0.62, 0.64, 0.09, 0.065, 0, BACK_CENTER_Y, 0.28, BACK_TILT)
  ])
  // A coluna a gás: de dentro do cubo até a base do estofado.
  const column = SEAT_TOP - 0.14 - 0.065
  const base: BufferGeometry[] = [
    cyl(0.038, 0.046, column, 0, 0.065 + column / 2, 0),
    cyl(0.065, 0.065, 0.08, 0, 0.12, 0),
    rbox(0.12, 0.38, 0.045, 0.01, 0, SEAT_TOP + 0.07, 0.34)
  ]
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5
    base.push(rbox(0.045, 0.045, 0.38, 0.015, Math.sin(a) * 0.18, 0.11, Math.cos(a) * 0.18, 0, a))
    base.push(cyl(0.055, 0.055, 0.045, Math.sin(a) * 0.37, 0.065, Math.cos(a) * 0.37, 10, Math.PI / 2))
  }
  for (const side of [-1, 1]) {
    base.push(rbox(0.035, 0.25, 0.035, 0.01, side * 0.34, SEAT_TOP + 0.09, 0.04))
    base.push(rbox(0.09, 0.045, 0.38, 0.02, side * 0.34, ARM_Y, -0.04))
  }
  return { top, base: fuse(base) }
}
