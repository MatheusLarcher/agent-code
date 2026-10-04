/**
 * O sol do escritório 3D (a única luz que projeta sombra): a câmera de sombra
 * cobre o prédio todo — e só ele —, refeita só quando a caixa das salas muda.
 */
import type { DirectionalLight } from 'three'
import { buildingBounds, type RoomLayout } from './layout'

/** Onde o sol fica em relação ao centro do prédio. */
export const SUN_OFFSET = { x: 7, y: 16, z: 11 }

/**
 * Enquadra a sombra do sol nas salas. `last` = assinatura do último ajuste;
 * devolve a nova (a mesma se nada mudou — aí nada é refeito). Sem salas, `last`.
 */
export function fitSunShadow(sun: DirectionalLight, rooms: readonly RoomLayout[], last: string): string {
  const b = buildingBounds([...rooms])
  if (!b) return last
  const sig = `${b.minX},${b.maxX},${b.minZ},${b.maxZ}`
  if (sig === last) return last
  const cx = (b.minX + b.maxX) / 2
  const cz = (b.minZ + b.maxZ) / 2
  const half = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 3
  sun.position.set(cx + SUN_OFFSET.x, SUN_OFFSET.y, cz + SUN_OFFSET.z)
  sun.target.position.set(cx, 0, cz)
  sun.target.updateMatrixWorld()
  const cam = sun.shadow.camera
  cam.left = -half
  cam.right = half
  cam.top = half
  cam.bottom = -half
  cam.near = 1
  cam.far = 60 + half * 2
  cam.updateProjectionMatrix()
  return sig
}
