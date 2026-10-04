/**
 * O fundo do escritório (three), medidas de officePlan.ts:
 *   lounge (fundo-esquerda)   aparador com ripado na parede, dois quadros,
 *                             tapete, sofá de 3 lugares com almofadas, mesa de
 *                             centro com planta, poltrona sage, luminária de pé e o
 *                             pendente quente sobre o tapete;
 *   sala de reunião (direita) piso de madeira, vidro na frente (com o vão da porta)
 *                             e à esquerda com montantes charcoal, mesa para 8 com
 *                             as cadeiras, ripado na parede do fundo, barra de luz
 *                             e a TV (moldura + a tela que o projetor/TV pinta).
 * Estático vai para a fusão da zona; ficam à parte as luminárias (o apagão troca
 * o material da cúpula e da lâmpada) e a tela da TV.
 */
import { Group, Mesh, type Material } from 'three'
import { box, cyl, disc, flat, plant } from './decorUtil'
import { meetingChairs } from './furniture'
import type { Kit } from './kit'
import { BACK_FACE_Z, DESK_HEIGHT, LOUNGE, MEETING } from './officePlan'
import { tagLod } from './roomLod'
import { CHAIR_BACK_Z, CHAIR_SEAT_Z, SEAT_Y } from './decorIslands'

export interface Lamp {
  shade: Mesh
  bulb: Mesh
}

export interface BackParts {
  /** Luminária de pé e pendente do lounge, barra de luz da reunião. */
  lamps: Lamp[]
  /** A tela da TV (o projetor desenha nela). */
  tv: Mesh
}

/** Cadeira de escritório solta (sala de reunião, poltrona): o grupo gira `yaw` (0 = quem senta olha para −Z). */
function looseChair(kit: Kit, parent: Group, x: number, z: number, yaw: number, seat: Material, scale = 1): void {
  const g = new Group()
  g.position.set(x, 0, z)
  g.rotation.y = yaw
  g.scale.setScalar(scale)
  parent.add(g)
  box(kit, g, seat, 0.46, 0.04, 0.32, 0, SEAT_Y, CHAIR_SEAT_Z, true)
  box(kit, g, seat, 0.44, 0.42, 0.05, 0, SEAT_Y + 0.27, CHAIR_BACK_Z, true).rotation.x = 0.08
  tagLod(cyl(kit, g, kit.mat.chair, 0.06, SEAT_Y - 0.06, 0, 0.03, CHAIR_SEAT_Z * 0.5), 'small')
  tagLod(cyl(kit, g, kit.mat.chair, 0.58, 0.04, 0, 0.02, 0), 'small')
}

function lamp(kit: Kit, zone: Group, shadeGeo: 'cone' | 'cyl', x: number, y: number, z: number, sx: number, sy: number): Lamp {
  const shade = new Mesh(kit.geo[shadeGeo], kit.mat.shade)
  shade.scale.set(sx, sy, sx)
  shade.position.set(x, y, z)
  const bulb = tagLod(new Mesh(kit.geo.leaf, kit.mat.bulb), 'detail')
  bulb.scale.setScalar(0.08)
  bulb.position.set(x, y - sy * 0.3, z)
  zone.add(shade, bulb)
  return { shade, bulb }
}

export function buildLounge(kit: Kit, zone: Group, statics: Group): Lamp[] {
  const m = kit.mat
  const L = LOUNGE
  const sb = L.sideboard
  box(kit, statics, m.shelf, sb.w, sb.h, sb.d, sb.x, sb.h / 2, sb.z, true)
  for (let i = 1; i < 6; i++) tagLod(box(kit, statics, m.oakDark, 0.012, sb.h - 0.06, 0.012, sb.x - sb.w / 2 + (i * sb.w) / 6, sb.h / 2, sb.z + sb.d / 2 + 0.004), 'detail')
  tagLod(plant(kit, statics, sb.x - 1.6, sb.h, sb.z, 0.45), 'detail')
  tagLod(plant(kit, statics, sb.x + 1.5, sb.h, sb.z, 0.38), 'detail')
  // Ripado de madeira na parede atrás do aparador (à esquerda) e os dois quadros.
  for (let i = 0; i < 16; i++) box(kit, statics, m.shelf, 0.035, 2.45, 0.07, -8.25 + i * 0.075, 1.25, BACK_FACE_Z + 0.04)
  L.art.forEach((x, i) => {
    box(kit, statics, m.shelf, 0.95, 1.05, 0.04, x, 1.9, BACK_FACE_Z + 0.02)
    box(kit, statics, m.paper, 0.85, 0.95, 0.012, x, 1.9, BACK_FACE_Z + 0.045)
    const art = cyl(kit, statics, i ? m.sage : m.oakDark, 0.62, 0.012, x, 0, BACK_FACE_Z + 0.06)
    art.rotation.x = Math.PI / 2
    art.position.set(x, 1.85, BACK_FACE_Z + 0.06)
  })
  disc(kit, statics, m.rugLounge, L.rug.rx, L.rug.rz, L.rug.x, 0.007, L.rug.z)
  // Sofá: base, almofadas do assento, encosto, braços, pés e as almofadas soltas.
  const s = L.sofa
  box(kit, statics, m.sofa, s.w, 0.24, s.d, s.x, 0.14, s.z, true)
  for (const dx of [-0.85, 0, 0.85]) box(kit, statics, m.sofa, 0.82, 0.1, s.d - 0.2, s.x + dx, 0.31, s.z + 0.08, true)
  box(kit, statics, m.sofa, s.w, 0.5, 0.22, s.x, 0.5, s.z - s.d / 2 + 0.11, true)
  for (const side of [-1, 1]) box(kit, statics, m.sofa, 0.2, 0.42, s.d, s.x + side * (s.w / 2 - 0.1), 0.39, s.z, true)
  for (const dx of [-1.15, 1.15]) for (const dz of [-0.3, 0.3]) tagLod(cyl(kit, statics, m.shelf, 0.05, 0.04, s.x + dx, 0, s.z + dz), 'detail')
  const p1 = box(kit, statics, m.sage, 0.42, 0.36, 0.14, s.x - 0.85, 0.5, s.z - 0.2, true)
  p1.rotation.z = -0.16
  const p2 = box(kit, statics, m.shelf, 0.4, 0.34, 0.13, s.x + 0.85, 0.5, s.z - 0.2, true)
  p2.rotation.z = 0.17
  // Mesa de centro com planta.
  const t = L.table
  cyl(kit, statics, m.shelf, t.r * 2, 0.05, t.x, t.h - 0.05, t.z, true)
  cyl(kit, statics, m.shelf, 0.16, t.h - 0.05, t.x, 0, t.z, true)
  tagLod(plant(kit, statics, t.x, t.h, t.z, 0.4), 'detail')
  // Poltrona sage (de frente para a mesa).
  looseChair(kit, statics, L.armchair.x, L.armchair.z, L.armchair.yaw, m.sage, 1.12)
  // Luminária de pé (base, haste de latão) e o pendente quente sobre o tapete.
  tagLod(cyl(kit, statics, m.metal, 0.3, 0.03, L.lamp.x, 0, L.lamp.z), 'small')
  cyl(kit, statics, m.brass, 0.03, 1.45, L.lamp.x, 0, L.lamp.z, true)
  const p = L.pendant
  tagLod(box(kit, statics, m.metal, 0.012, 2.8 - p.y - 0.1, 0.012, p.x, (2.8 + p.y + 0.1) / 2, p.z), 'small')
  return [lamp(kit, zone, 'cone', L.lamp.x, 1.52, L.lamp.z, 0.36, 0.28), lamp(kit, zone, 'cyl', p.x, p.y, p.z, 0.62, 0.18)]
}

export function buildMeeting(kit: Kit, zone: Group, statics: Group): BackParts {
  const m = kit.mat
  const M = MEETING
  const w = M.x1 - M.x0
  const d = M.z1 - M.z0
  const cx = (M.x0 + M.x1) / 2
  const cz = (M.z0 + M.z1) / 2
  flat(kit, statics, m.deskTop, w, d, cx, 0.008, cz)
  // Vidro (não projeta sombra) na frente, com o vão da porta, e à esquerda; montantes, vigas e trilhos.
  const H = 2.62
  const pane = (len: number, x: number, z: number, ry: number): void => {
    const g = new Mesh(kit.geo.plane, m.pane)
    g.scale.set(len, H - 0.06, 1)
    g.position.set(x, H / 2, z)
    g.rotation.y = ry
    statics.add(g)
  }
  pane(M.door.x0 - M.x0, (M.x0 + M.door.x0) / 2, M.z1, 0)
  pane(M.x1 - M.door.x1, (M.door.x1 + M.x1) / 2, M.z1, 0)
  pane(d, M.x0, cz, Math.PI / 2)
  for (const x of [M.x0, M.door.x0, M.door.x1, 6.2, M.x1 - 0.03]) box(kit, statics, m.charcoal, 0.05, H, 0.06, x, H / 2, M.z1, true)
  for (const z of [M.z0 + 0.05, cz]) box(kit, statics, m.charcoal, 0.06, H, 0.05, M.x0, H / 2, z, true)
  box(kit, statics, m.charcoal, w + 0.04, 0.06, 0.07, cx, H, M.z1)
  box(kit, statics, m.charcoal, 0.07, 0.06, d, M.x0, H, cz)
  for (const [x0, x1] of [
    [M.x0, M.door.x0],
    [M.door.x1, M.x1]
  ]) tagLod(box(kit, statics, m.charcoal, x1 - x0, 0.05, 0.06, (x0 + x1) / 2, 0.025, M.z1), 'small')
  tagLod(box(kit, statics, m.charcoal, 0.06, 0.05, d, M.x0, 0.025, cz), 'small')
  tagLod(box(kit, statics, m.metal, 0.03, 0.42, 0.04, M.door.x1 - 0.12, 1.0, M.z1 + 0.03), 'detail')
  // Mesa para 8, as cadeiras e uma planta no meio.
  const T = M.table
  box(kit, statics, m.deskTop, T.w, 0.06, T.d, T.x, DESK_HEIGHT, T.z, true)
  for (const dx of [-1.0, 1.0]) box(kit, statics, m.metal, 0.1, DESK_HEIGHT - 0.03, T.d * 0.65, T.x + dx, (DESK_HEIGHT - 0.03) / 2, T.z, true)
  for (const c of meetingChairs()) looseChair(kit, statics, c.x, c.z, c.yaw, m.sofa)
  tagLod(plant(kit, statics, T.x, DESK_HEIGHT + 0.03, T.z, 0.42), 'detail')
  // Ripado de madeira na parede do fundo da sala e a TV com moldura.
  for (let i = 0; i < 44; i++) box(kit, statics, m.shelf, 0.04, 2.5, 0.06, M.x0 + 0.65 + i * 0.12, 1.25, BACK_FACE_Z + 0.03)
  const tvz = BACK_FACE_Z + 0.08
  box(kit, statics, m.charcoal, M.tv.w + 0.1, M.tv.h + 0.1, 0.06, M.tv.x, M.tv.y, tvz, true)
  const tv = new Mesh(kit.geo.plane, m.screenOff)
  tv.scale.set(M.tv.w, M.tv.h, 1)
  tv.position.set(M.tv.x, M.tv.y, tvz + 0.035)
  zone.add(tv)
  // Barra de luz de latão sobre a mesa.
  box(kit, statics, m.brass, 2.6, 0.05, 0.07, T.x, 2.3, T.z)
  for (const dx of [-1.0, 1.0]) tagLod(box(kit, statics, m.metal, 0.01, 0.45, 0.01, T.x + dx, 2.55, T.z), 'small')
  const strip = new Mesh(kit.geo.box, m.shade)
  strip.scale.set(2.5, 0.012, 0.05)
  strip.position.set(T.x, 2.27, T.z)
  const bulb = tagLod(new Mesh(kit.geo.box, m.bulb), 'detail')
  bulb.scale.set(0.1, 0.01, 0.03)
  bulb.position.set(T.x, 2.262, T.z)
  zone.add(strip, bulb)
  return { lamps: [{ shade: strip, bulb }], tv }
}
