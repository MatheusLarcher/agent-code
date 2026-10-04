/**
 * As três luzes do escritório 3D (as únicas, em qualquer nível de energia) e o
 * sol (a única que projeta sombra): a câmera de sombra cobre o escritório — e
 * só ele —, refeita só quando a caixa muda.
 */
import { AmbientLight, DirectionalLight, HemisphereLight, type Scene } from 'three'
import { buildingBounds, type RoomLayout } from './layout'

export const SHADOW_MAP_SIZE = 2048

/** Hemisférica quente + ambiente fraca + o sol com sombra suave, já na cena. */
export function createSceneLights(scene: Scene): { hemi: HemisphereLight; amb: AmbientLight; sun: DirectionalLight } {
  const hemi = new HemisphereLight(0xfff1dc, 0x3a3040, 1.25)
  const amb = new AmbientLight(0xffe8d0, 0.2)
  const sun = new DirectionalLight(0xffe2b8, 1.7)
  sun.castShadow = true
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
  sun.shadow.bias = -0.0005
  sun.shadow.normalBias = 0.02
  sun.shadow.radius = 3
  sun.position.set(SUN_OFFSET.x, SUN_OFFSET.y, SUN_OFFSET.z)
  scene.add(hemi, amb, sun, sun.target)
  return { hemi, amb, sun }
}

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
