/**
 * As 4 ilhas em U do escritório (three), cada uma no grupo da zona dela: 6
 * estações (tampo de carvalho, painéis e gaveteiro cream, monitor charcoal,
 * teclado, mouse e um enfeite — caneca ou livro), a divisória baixa de feltro
 * atrás de cada mesa e na lateral de fora das mesas dos braços, a jardineira
 * cream em cima da divisória do fundo, a estante de madeira com planta na
 * ponta do braço da frente e o tapete arredondado sob o U. Medidas de
 * officePlan.ts; cada estação é montada no referencial dela e girada pelo yaw.
 *
 * Estático vai para a fusão da zona. Por ilha ficam à parte: as 6 telas (uma
 * Mesh por mesa: textura própria), as cadeiras do mockup (chairModel.ts; InstancedMesh de 6 — escondidas
 * no foco do monitor e afastadas na hora de sentar/levantar) e a pilha de papéis.
 */
import { Group, InstancedMesh, Matrix4, Mesh, Object3D, type BufferGeometry } from 'three'
import { MONITOR_SCREEN_FRONT } from './cameraRig'
import { officeChairGeometries } from './chairModel'
import { box, cyl, disc, instanced, plant, type Place } from './decorUtil'
import type { Kit } from './kit'
import type { DeskLayout } from './layout'
import {
  CHAIR_PULL,
  DESK_D,
  DESK_HEIGHT,
  DESK_W,
  deskPoint,
  ISLAND_RUG,
  ISLAND_SHELF,
  ISLANDS,
  islandShelf,
  KEYBOARD_FRONT,
  MONITOR_BACK,
  MONITOR_Y,
  PARTITION_BACK,
  SEAT_FRONT,
  type Placed
} from './officePlan'
import { createPaperPiles, type PaperPiles } from './paperPile'
import { tagLod } from './roomLod'
import { rng } from './textures'

export { CHAIR_PULL } from './officePlan'

export interface IslandParts {
  /** As telas das 6 mesas da ilha, na ordem do índice global. */
  screens: Mesh[]
  piles: PaperPiles
  /** Põe a cadeira da mesa local `i` recuada `pull` m (0 = no lugar) ou escondida. */
  chair(i: number, pull: number, hidden: boolean): void
  /** Geometrias próprias (a cadeira em duas peças), liberadas no dispose. */
  geos: BufferGeometry[]
}

const dummy = new Object3D()
const ZERO = new Matrix4().makeScale(0, 0, 0)
/** Divisória de feltro: altura acima do tampo e espessura. */
const FELT_H = 0.42
const FELT_T = 0.05

/** Onde fica a cadeira de uma mesa recuada `pull` ao longo do eixo da mesa, no giro dela. */
function chairPlace(d: DeskLayout, pull: number): Place {
  const p = deskPoint(d, 0, SEAT_FRONT + pull)
  return { x: p.x, y: 0, z: p.z, sx: 1, sy: 1, sz: 1, ry: d.yaw }
}

/** Grupo estático no lugar e no giro dados: as peças entram no referencial dele (a fusão usa a matriz do mundo). */
function placedGroup(statics: Group, at: Placed): Group {
  const g = new Group()
  g.position.set(at.x, 0, at.z)
  g.rotation.y = at.yaw
  statics.add(g)
  return g
}

/** Uma estação no referencial dela (monitor em −Z, quem senta em +Z; `out` = lado do gaveteiro). */
function station(kit: Kit, g: Group, d: DeskLayout): void {
  const m = kit.mat
  const DH = DESK_HEIGHT
  const mz = -MONITOR_BACK
  box(kit, g, m.deskTop, DESK_W, 0.05, DESK_D, 0, DH, 0, true)
  for (const s of [-1, 1]) box(kit, g, m.cream, 0.045, DH - 0.03, DESK_D * 0.85, s * (DESK_W / 2 - 0.08), (DH - 0.03) / 2, 0, true)
  box(kit, g, m.cream, DESK_W - 0.2, 0.36, 0.03, 0, 0.5, -DESK_D / 2 + 0.12, true)
  // Gaveteiro do lado `out` e os puxadores.
  const gx = d.out * 0.5
  box(kit, g, m.cream, 0.26, 0.54, 0.5, gx, 0.29, -0.15, true)
  for (let i = 0; i < 3; i++) tagLod(box(kit, g, m.metal, 0.14, 0.012, 0.01, gx, 0.14 + i * 0.17, -0.15 + 0.252), 'detail')
  // Monitor (moldura, coluna e base), teclado, mouse e o enfeite.
  box(kit, g, m.frame, kit.geo.screen.parameters.width + 0.06, kit.geo.screen.parameters.height + 0.06, 0.04, 0, MONITOR_Y, mz, true)
  box(kit, g, m.frame, 0.05, MONITOR_Y - DH - 0.2, 0.05, 0, (MONITOR_Y + DH - 0.2) / 2, mz - 0.04, true)
  box(kit, g, m.frame, 0.26, 0.02, 0.18, 0, DH + 0.035, mz - 0.02, true)
  tagLod(box(kit, g, m.keyboard, 0.46, 0.022, 0.15, 0, DH + 0.036, KEYBOARD_FRONT), 'small')
  tagLod(box(kit, g, m.keyboard, 0.05, 0.025, 0.08, 0.33, DH + 0.037, KEYBOARD_FRONT), 'small')
  if (d.index % 2 === 0) tagLod(cyl(kit, g, m.mug, 0.08, 0.1, 0.55, DH + 0.025, -0.12), 'detail')
  else {
    tagLod(box(kit, g, m.binder, 0.2, 0.035, 0.27, 0.55, DH + 0.045, -0.08), 'detail')
    tagLod(box(kit, g, m.paper, 0.19, 0.006, 0.26, 0.55, DH + 0.066, -0.08), 'detail')
  }
  // Divisória baixa de feltro: atrás das mesas dos braços (a do fundo é uma só, na ilha) e na lateral de fora delas.
  if (d.k >= 2) {
    const top = DH + 0.025
    box(kit, g, m.felt, DESK_W, FELT_H, FELT_T, 0, top + FELT_H / 2, -PARTITION_BACK, true)
    box(kit, g, m.felt, FELT_T, FELT_H, DESK_D + FELT_T, -d.out * (DESK_W / 2 + FELT_T / 2), top + FELT_H / 2, -FELT_T / 2, true)
  }
}

/** Uma ilha: estático em `statics`, telas/cadeiras/pilha em `zone`. `desks` = as 6 mesas dela. */
export function buildIsland(kit: Kit, island: number, desks: readonly DeskLayout[], zone: Group, statics: Group): IslandParts {
  const m = kit.mat
  const isl = ISLANDS[island]
  const r = rng(101 + island * 7)
  for (const d of desks) station(kit, placedGroup(statics, d), d)
  // Divisória do fundo do U (atrás das duas mesas do fundo), a jardineira em cima dela e as plantinhas.
  const top = DESK_HEIGHT + 0.025
  const bz = isl.z - PARTITION_BACK
  box(kit, statics, m.felt, DESK_W * 2 + FELT_T, FELT_H, FELT_T, isl.x, top + FELT_H / 2, bz, true)
  box(kit, statics, m.cream, 1.0, 0.1, 0.2, isl.x, top + FELT_H + 0.05, bz, true)
  for (const dx of [-0.34, 0, 0.34]) plant(kit, statics, isl.x + dx, top + FELT_H, bz, 0.3)
  // Estante na ponta de fora do braço da frente: corpo de carvalho, prateleiras cream, livros e uma planta em cima.
  const sh = placedGroup(statics, islandShelf(island))
  box(kit, sh, m.shelf, ISLAND_SHELF.w, 0.6, ISLAND_SHELF.d, 0, 0.3, 0, true)
  for (const y of [0.22, 0.42]) box(kit, sh, m.cream, ISLAND_SHELF.w - 0.08, 0.025, ISLAND_SHELF.d - 0.02, 0, y, 0.02)
  for (let i = 0; i < 5; i++) {
    const h = 0.12 + r() * 0.05
    tagLod(box(kit, sh, r() < 0.5 ? m.binder : m.paper, 0.06, h, 0.18, -0.2 + i * 0.09, 0.235 + h / 2, 0.04), 'detail')
  }
  plant(kit, sh, 0, 0.6, 0, 0.55)
  disc(kit, statics, m.rugIsland, ISLAND_RUG.rx, ISLAND_RUG.rz, isl.x, 0.006, isl.z + ISLAND_RUG.dz)

  // Telas (textura própria por mesa), giradas com a mesa.
  const screens = desks.map((d) => {
    const s = new Mesh(kit.geo.screen, m.screenOff)
    const p = deskPoint(d, 0, -MONITOR_BACK + MONITOR_SCREEN_FRONT)
    s.position.set(p.x, MONITOR_Y, p.z)
    s.rotation.y = d.yaw
    s.userData.charKey = null
    zone.add(s)
    return s
  })

  // Cadeiras: o estofado e o metal, uma InstancedMesh de 6 cadeiras cada.
  const geo = officeChairGeometries()
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
