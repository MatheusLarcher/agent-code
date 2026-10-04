/**
 * A casca do escritório (three): piso de concreto claro com a borda escura de
 * maquete, parede do fundo com rodapé, parede da direita (com o vão da porta;
 * a folha é de decorWall.ts), a parede de vidro da esquerda — peitoril,
 * montantes, travessa, viga e os painéis com o CÉU da hora (kit.sky, a mesma
 * textura das janelas de antes, com a silhueta da cidade) atrás do vidro — e as
 * trilhas no chão: do tapete da Central até o de cada ilha e o eixo floreira ↔
 * porta. Tudo estático (vai para a fusão da zona), menos os painéis de céu: uma
 * malha só, cujo material o apagão troca (luar).
 */
import { Mesh, PlaneGeometry, type BufferGeometry, type Group } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { box, flat } from './decorUtil'
import type { Kit } from './kit'
import {
  BACK_FACE_Z,
  BACK_WALL_H,
  CONSOLE,
  DOOR,
  GLASS_H,
  GLASS_MULLIONS,
  GLASS_PLANTER,
  GLASS_SILL_H,
  GLASS_TOP,
  GLASS_X,
  ISLAND_RUG,
  ISLANDS,
  OFFICE,
  OFFICE_D,
  OFFICE_W,
  PLAZA_RUG,
  RIGHT_FACE_X,
  RIGHT_WALL_H,
  RIGHT_WALL_Z1,
  RIGHT_X,
  WALL_T
} from './officePlan'
import { tagLod } from './roomLod'

export interface ShellParts {
  /** Os painéis de céu atrás do vidro (uma malha; o apagão troca o material). */
  skies: Mesh[]
  /** Geometrias próprias (o piso e o céu), liberadas no dispose. */
  geos: BufferGeometry[]
}

const TRAIL_W = 0.12

export function buildShell(kit: Kit, zone: Group, statics: Group): ShellParts {
  const m = kit.mat
  const cx = (OFFICE.x0 + OFFICE.x1) / 2
  const cz = (OFFICE.z0 + OFFICE.z1) / 2
  // Piso: UV na escala do escritório (o concreto repete a cada 2 m) e a borda escura por baixo.
  const floorGeo = new PlaneGeometry(OFFICE_W, OFFICE_D)
  const uv = floorGeo.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (OFFICE_W / 2), uv.getY(i) * (OFFICE_D / 2))
  const floor = new Mesh(floorGeo, m.floor)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(cx, 0, cz)
  floor.receiveShadow = true
  zone.add(floor)
  box(kit, statics, m.charcoal, OFFICE_W + 0.1, 0.18, OFFICE_D + 0.1, cx, -0.1, cz)

  // Parede do fundo, rodapé de madeira e o acabamento do alto.
  box(kit, statics, m.wall, OFFICE_W, BACK_WALL_H, WALL_T, cx, BACK_WALL_H / 2, OFFICE.z0, true)
  tagLod(box(kit, statics, m.baseboard, OFFICE_W, 0.08, 0.025, cx, 0.04, BACK_FACE_Z + 0.012), 'small')
  box(kit, statics, m.wallCap, OFFICE_W + 0.04, 0.04, WALL_T + 0.04, cx, BACK_WALL_H + 0.02, OFFICE.z0)

  // Parede da direita, com o vão da porta (e a verga em cima).
  const d0 = DOOR.z - DOOR.width / 2
  const d1 = DOOR.z + DOOR.width / 2
  for (const [z0, z1] of [
    [OFFICE.z0, d0],
    [d1, RIGHT_WALL_Z1]
  ]) {
    box(kit, statics, m.wall, WALL_T, RIGHT_WALL_H, z1 - z0, RIGHT_X, RIGHT_WALL_H / 2, (z0 + z1) / 2, true)
    box(kit, statics, m.wallCap, WALL_T + 0.04, 0.04, z1 - z0, RIGHT_X, RIGHT_WALL_H + 0.02, (z0 + z1) / 2)
    tagLod(box(kit, statics, m.baseboard, 0.025, 0.08, z1 - z0, RIGHT_FACE_X - 0.012, 0.04, (z0 + z1) / 2), 'small')
  }
  box(kit, statics, m.wall, WALL_T, RIGHT_WALL_H - DOOR.height - 0.05, DOOR.width, RIGHT_X, (RIGHT_WALL_H + DOOR.height + 0.05) / 2, DOOR.z, true)

  // Parede de vidro: peitoril, montantes, travessa, viga do alto e o vidro.
  const len = OFFICE_D
  box(kit, statics, m.wall, 0.14, GLASS_SILL_H, len, GLASS_X, GLASS_SILL_H / 2, cz, true)
  box(kit, statics, m.charcoal, 0.16, 0.05, len, GLASS_X, GLASS_SILL_H + 0.025, cz)
  box(kit, statics, m.charcoal, 0.14, GLASS_H - GLASS_TOP, len, GLASS_X, (GLASS_H + GLASS_TOP) / 2, cz, true)
  tagLod(box(kit, statics, m.charcoal, 0.06, 0.05, len, GLASS_X + 0.02, 1.05, cz), 'small')
  for (const z of GLASS_MULLIONS) box(kit, statics, m.charcoal, 0.09, GLASS_TOP - GLASS_SILL_H, 0.07, GLASS_X, (GLASS_TOP + GLASS_SILL_H) / 2, z, true)
  const glass = new Mesh(kit.geo.plane, m.pane)
  glass.rotation.y = Math.PI / 2
  glass.scale.set(len, GLASS_TOP - GLASS_SILL_H, 1)
  glass.position.set(GLASS_X + 0.03, (GLASS_TOP + GLASS_SILL_H) / 2, cz)
  tagLod(glass, 'detail')
  zone.add(glass)
  // Céu atrás do vidro: um painel por vão entre montantes, numa malha só.
  const panes: BufferGeometry[] = []
  const edges = [OFFICE.z0 + WALL_T / 2, ...GLASS_MULLIONS, OFFICE.z1]
  for (let i = 0; i + 1 < edges.length; i++) {
    const z0 = edges[i] + 0.04
    const z1 = edges[i + 1] - 0.04
    if (z1 - z0 < 0.2) continue
    const g = new PlaneGeometry(z1 - z0, GLASS_TOP - GLASS_SILL_H)
    g.rotateY(Math.PI / 2)
    g.translate(GLASS_X - 0.03, (GLASS_TOP + GLASS_SILL_H) / 2, (z0 + z1) / 2)
    panes.push(g)
  }
  const skyGeo = mergeGeometries(panes, false)
  for (const g of panes) g.dispose()
  const sky = new Mesh(skyGeo ?? new PlaneGeometry(1, 1), m.sky)
  zone.add(sky)

  // Trilhas no chão: tapete da Central → tapete de cada ilha, e o eixo floreira ↔ porta.
  const y = 0.004
  for (const isl of ISLANDS) {
    const dx = isl.x - CONSOLE.x
    const dz = isl.z + ISLAND_RUG.dz - CONSOLE.z
    const d = Math.hypot(dx, dz)
    const ux = dx / d
    const uz = dz / d
    // Onde a reta sai do tapete da ilha (elipse rx × rz).
    const rIsl = 1 / Math.hypot(ux / ISLAND_RUG.rx, uz / ISLAND_RUG.rz)
    const a = PLAZA_RUG.r + 0.02
    const b = d - rIsl - 0.02
    if (b <= a) continue
    const mid = (a + b) / 2
    tagLod(flat(kit, statics, m.trail, TRAIL_W, b - a, CONSOLE.x + ux * mid, y, CONSOLE.z + uz * mid, Math.atan2(ux, uz)), 'small')
  }
  const left0 = GLASS_PLANTER.x + GLASS_PLANTER.d / 2 + 0.05
  const left1 = PLAZA_RUG.x - PLAZA_RUG.r - 0.02
  const right0 = PLAZA_RUG.x + PLAZA_RUG.r + 0.02
  const right1 = RIGHT_FACE_X - 0.05
  tagLod(flat(kit, statics, m.trail, left1 - left0, TRAIL_W, (left0 + left1) / 2, y, DOOR.z), 'small')
  tagLod(flat(kit, statics, m.trail, right1 - right0, TRAIL_W, (right0 + right1) / 2, y, DOOR.z), 'small')

  return { skies: [sky], geos: [floorGeo, sky.geometry] }
}
