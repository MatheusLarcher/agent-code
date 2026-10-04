/**
 * As 4 ilhas do escritório (three), cada uma no grupo da zona dela: 4 estações
 * (tampo de carvalho, painéis e gaveteiro cream, monitor charcoal, teclado,
 * mouse e um enfeite — caneca ou livro), a divisória de feltro em cruz com a
 * jardineira em cima, a estante de madeira com planta na ponta da frente e o
 * tapete arredondado. Medidas de officePlan.ts; a estação `dir −1` é espelhada.
 *
 * Estático vai para a fusão da zona. Por ilha ficam à parte: as 4 telas (uma
 * Mesh por mesa: textura própria), as cadeiras (InstancedMesh de 4 — escondidas
 * no foco do monitor e afastadas na hora de sentar/levantar) e a pilha de papéis.
 */
import { Group, InstancedMesh, Matrix4, Mesh, Object3D, type BufferGeometry } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MONITOR_SCREEN_FRONT } from './cameraRig'
import { box, cyl, disc, instanced, plant, type Place } from './decorUtil'
import type { Kit } from './kit'
import type { DeskLayout } from './layout'
import { DESK_D, DESK_HEIGHT, DESK_W, ISLAND_RUG, ISLAND_SHELF_Z, ISLANDS, KEYBOARD_FRONT, MONITOR_BACK, MONITOR_Y, SEAT_FRONT } from './officePlan'
import { createPaperPiles, type PaperPiles } from './paperPile'
import { tagLod } from './roomLod'
import { rng } from './textures'

/** Centro do assento (topo em 0,33): baixo como os personagens — sentados, os pés tocam o chão. */
export const SEAT_Y = 0.31
/** Quanto a cadeira recua (m) no meio do sentar/levantar. */
export const CHAIR_PULL = 0.38
/** Centro do assento e do encosto atrás do quadril (o encosto encosta nas costas). */
export const CHAIR_SEAT_Z = 0.15
export const CHAIR_BACK_Z = 0.25

export interface IslandParts {
  /** As telas das 4 mesas da ilha, na ordem do índice global. */
  screens: Mesh[]
  piles: PaperPiles
  /** Põe a cadeira da mesa local `i` recuada `pull` m (0 = no lugar) ou escondida. */
  chair(i: number, pull: number, hidden: boolean): void
  /** Geometrias próprias (a cadeira em duas peças), liberadas no dispose. */
  geos: BufferGeometry[]
}

const dummy = new Object3D()
const ZERO = new Matrix4().makeScale(0, 0, 0)

/**
 * A cadeira em duas geometrias no referencial dela (a origem é o quadril de
 * quem senta, que olha para −Z): o estofado — assento curto que termina no
 * quadril (a coxa desce livre pela borda) e o encosto logo atrás das costas — e
 * o metal (coluna e a base de rodinhas, com os pés dentro dela). Duas
 * InstancedMesh por ilha.
 */
function chairGeometries(kit: Kit): { top: BufferGeometry; base: BufferGeometry } {
  const piece = (src: BufferGeometry, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0): BufferGeometry => {
    dummy.position.set(x, y, z)
    dummy.rotation.set(rx, 0, 0)
    dummy.scale.set(sx, sy, sz)
    dummy.updateMatrix()
    return (src.index ? src.toNonIndexed() : src.clone()).applyMatrix4(dummy.matrix)
  }
  const parts = [
    [piece(kit.geo.box, 0.46, 0.04, 0.32, 0, SEAT_Y, CHAIR_SEAT_Z), piece(kit.geo.box, 0.44, 0.42, 0.05, 0, SEAT_Y + 0.27, CHAIR_BACK_Z, 0.08)],
    [piece(kit.geo.cyl, 0.06, SEAT_Y - 0.06, 0.06, 0, SEAT_Y / 2, CHAIR_SEAT_Z * 0.5), piece(kit.geo.cyl, 0.58, 0.04, 0.58, 0, 0.04, 0)]
  ]
  const [top, base] = parts.map((geos) => {
    const g = mergeGeometries(geos, false)!
    for (const x of geos) x.dispose()
    return g
  })
  return { top, base }
}

/** Onde fica a cadeira de uma mesa recuada `pull` (o giro de quem senta na mesa de fundo). */
function chairPlace(d: DeskLayout, pull: number): Place {
  return { x: d.x, y: 0, z: d.z + d.dir * (SEAT_FRONT + pull), sx: 1, sy: 1, sz: 1, ry: d.dir === 1 ? 0 : Math.PI }
}

/** Uma ilha: estático em `statics`, telas/cadeiras/pilha em `zone`. `desks` = as 4 mesas dela. */
export function buildIsland(kit: Kit, island: number, desks: readonly DeskLayout[], zone: Group, statics: Group): IslandParts {
  const m = kit.mat
  const isl = ISLANDS[island]
  const DH = DESK_HEIGHT
  const r = rng(101 + island * 7)
  for (const d of desks) {
    const dir = d.dir
    const at = (dz: number): number => d.z + dir * dz
    const mz = at(-MONITOR_BACK)
    box(kit, statics, m.deskTop, DESK_W, 0.05, DESK_D, d.x, DH, d.z, true)
    for (const s of [-1, 1]) box(kit, statics, m.cream, 0.045, DH - 0.03, DESK_D * 0.85, d.x + s * (DESK_W / 2 - 0.08), (DH - 0.03) / 2, d.z, true)
    box(kit, statics, m.cream, DESK_W - 0.2, 0.36, 0.03, d.x, 0.5, at(-DESK_D / 2 + 0.12), true)
    // Gaveteiro do lado de fora da ilha e os puxadores.
    const gx = d.x + d.out * 0.5
    box(kit, statics, m.cream, 0.26, 0.54, 0.5, gx, 0.29, at(-0.15), true)
    for (let i = 0; i < 3; i++) tagLod(box(kit, statics, m.metal, 0.14, 0.012, 0.01, gx, 0.14 + i * 0.17, at(-0.15 + 0.252)), 'detail')
    // Monitor (moldura, coluna e base), teclado, mouse e o enfeite.
    box(kit, statics, m.frame, kit.geo.screen.parameters.width + 0.06, kit.geo.screen.parameters.height + 0.06, 0.04, d.x, MONITOR_Y, mz, true)
    box(kit, statics, m.frame, 0.05, MONITOR_Y - DH - 0.2, 0.05, d.x, (MONITOR_Y + DH - 0.2) / 2, mz - dir * 0.04, true)
    box(kit, statics, m.frame, 0.26, 0.02, 0.18, d.x, DH + 0.035, mz - dir * 0.02, true)
    tagLod(box(kit, statics, m.keyboard, 0.46, 0.022, 0.15, d.x, DH + 0.036, at(KEYBOARD_FRONT)), 'small')
    tagLod(box(kit, statics, m.keyboard, 0.05, 0.025, 0.08, d.x + dir * 0.33, DH + 0.037, at(KEYBOARD_FRONT)), 'small')
    if (d.index % 2 === 0) tagLod(cyl(kit, statics, m.mug, 0.08, 0.1, d.x + dir * 0.55, DH + 0.025, at(-0.12)), 'detail')
    else {
      tagLod(box(kit, statics, m.binder, 0.2, 0.035, 0.27, d.x + dir * 0.55, DH + 0.045, at(-0.08)), 'detail')
      tagLod(box(kit, statics, m.paper, 0.19, 0.006, 0.26, d.x + dir * 0.55, DH + 0.066, at(-0.08)), 'detail')
    }
  }
  // Divisória de feltro em cruz, a jardineira em cima dela e as plantinhas.
  const top = DH + 0.025
  box(kit, statics, m.felt, DESK_W * 2, 0.42, 0.05, isl.x, top + 0.21, isl.z, true)
  box(kit, statics, m.felt, 0.05, 0.42, DESK_D * 2, isl.x, top + 0.21, isl.z, true)
  box(kit, statics, m.cream, 1.0, 0.1, 0.2, isl.x, top + 0.47, isl.z, true)
  for (const dx of [-0.34, 0, 0.34]) plant(kit, statics, isl.x + dx, top + 0.42, isl.z, 0.3)
  // Estante na ponta da frente: corpo de carvalho, prateleiras cream, livros e uma planta em cima.
  const sz = isl.z + ISLAND_SHELF_Z
  box(kit, statics, m.shelf, 0.62, 0.6, 0.3, isl.x, 0.3, sz, true)
  for (const y of [0.22, 0.42]) box(kit, statics, m.cream, 0.54, 0.025, 0.28, isl.x, y, sz + 0.02)
  for (let i = 0; i < 5; i++) {
    const h = 0.12 + r() * 0.05
    tagLod(box(kit, statics, r() < 0.5 ? m.binder : m.paper, 0.06, h, 0.18, isl.x - 0.2 + i * 0.09, 0.235 + h / 2, sz + 0.04), 'detail')
  }
  plant(kit, statics, isl.x, 0.6, sz, 0.55)
  disc(kit, statics, m.rugIsland, ISLAND_RUG.rx, ISLAND_RUG.rz, isl.x, 0.006, isl.z + ISLAND_RUG.dz)

  // Telas (textura própria por mesa).
  const screens = desks.map((d) => {
    const s = new Mesh(kit.geo.screen, m.screenOff)
    s.position.set(d.x, MONITOR_Y, d.z - d.dir * MONITOR_BACK + d.dir * MONITOR_SCREEN_FRONT)
    s.rotation.y = d.dir === 1 ? 0 : Math.PI
    s.userData.charKey = null
    zone.add(s)
    return s
  })

  // Cadeiras: o estofado e o metal, uma InstancedMesh de 4 cadeiras cada.
  const geo = chairGeometries(kit)
  const placed = desks.map((d) => chairPlace(d, 0))
  const chairs: InstancedMesh[] = [instanced(zone, geo.top, m.chairSeat, placed), tagLod(instanced(zone, geo.base, m.chair, placed), 'small')]
  // A esfera de culling já cobre a cadeira recuada (calcula com as recuadas e volta).
  const pulled = desks.map((d) => chairPlace(d, CHAIR_PULL))
  for (const im of chairs) {
    pulled.forEach((p, i) => setPlace(im, i, p))
    im.computeBoundingSphere()
    im.boundingSphere!.radius += 0.5
    placed.forEach((p, i) => setPlace(im, i, p))
  }
  const state = desks.map(() => ({ pull: 0, hidden: false }))

  const piles = createPaperPiles(kit, { desks }, zone)
  return {
    screens,
    piles,
    geos: [geo.top, geo.base],
    chair(i, pull, hidden) {
      const s = state[i]
      const d = desks[i]
      if (!s || !d || (s.pull === pull && s.hidden === hidden)) return
      s.pull = pull
      s.hidden = hidden
      const p = hidden ? null : chairPlace(d, pull)
      for (const im of chairs) {
        if (p) setPlace(im, i, p)
        else im.setMatrixAt(i, ZERO)
        im.instanceMatrix.needsUpdate = true
      }
    }
  }
}

function setPlace(im: InstancedMesh, i: number, p: Place): void {
  dummy.position.set(p.x, p.y, p.z)
  dummy.rotation.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0)
  dummy.scale.set(p.sx, p.sy, p.sz)
  dummy.updateMatrix()
  im.setMatrixAt(i, dummy.matrix)
  im.instanceMatrix.needsUpdate = true
}
