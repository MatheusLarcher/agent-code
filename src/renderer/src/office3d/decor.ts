/**
 * Uma sala do escritório 3D: piso de tábuas, parede do fundo alta com janelas
 * (céu da hora local), rodapé, placa do projeto, quadro de cortiça com post-its
 * (o "kanban" do PO), estante, plantas, luminárias, máquina de café (de frente
 * para a sala, com espaço para a fila), tapete com o pufe do cochilo e a porta
 * na parede da esquerda (a folha gira quando alguém passa). As posições vêm de
 * furniture.ts — a mesma fonte da grade de navegação.
 *
 * Móveis que se repetem por mesa (tampo, pés, monitor, teclado, caneca,
 * cadeira) são InstancedMesh POR SALA, com a bounding sphere calculada sobre as
 * instâncias (o culling do three e o da sala funcionam): poucas chamadas de
 * desenho por sala, seja qual for o número de mesas. Por sala só o piso (UV na
 * escala da sala), a placa e as telas acesas são recursos próprios —
 * `dispose()` libera exatamente isso.
 *
 * LOD (roomLod.ts): detalhes (livros, post-its, xícaras, folhas, LEDs…) levam
 * userData.lod = 'detail' e somem no MÉDIO; decoração pequena (luminárias,
 * vasos, rodapés, teclados, pés de cadeira, pilhas de papel…) leva 'small' e
 * some no LONGE.
 *
 * Energia (blackout.ts): a sala expõe as luminárias (cúpula e lâmpada, para
 * apagar trocando o material), o céu das janelas (luar no apagão) e a pilha de
 * papéis de cada mesa (o contexto usado do dono, paperPile.ts).
 */
import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PlaneGeometry,
  type BufferGeometry,
  type Material
} from 'three'
import { DOOR_HEIGHT, MACHINE_OFFSET, PUFE_RADIUS, roomFurniture, type RoomFurniture } from './furniture'
import type { Kit, ScreenStatus } from './kit'
import { DESK_HEIGHT, MONITOR_BACK, MONITOR_Y, type RoomLayout } from './layout'
import type { MonitorTexture, ScreenPage } from './monitorTexture'
import { createPaperPiles, type PaperPiles } from './paperPile'
import { collectRoomLod, roomBox, tagLod, type RoomLod } from './roomLod'
import { createSignTexture, type SignTexture } from './sign'
import { rng } from './textures'

export const BACK_WALL_H = 1.7
export const SIDE_WALL_H = 0.6
/** Centro do assento: baixo como os personagens (sentados, os pés tocam o chão). */
export const SEAT_Y = 0.36

export interface ScreenView {
  mesh: Mesh
  state: 'off' | 'saver' | 'on'
  /** Textura da tela acesa (na resolução do nível); null apagada, protetor ou LONGE. */
  on: { mat: MeshBasicMaterial; mon: MonitorTexture } | null
  /** O que mostrar acesa: guardado mesmo com a sala fora da tela (desenha quando voltar). */
  page: ScreenPage | null
  accent: string
  /** Cor do bloco no LONGE. */
  status: ScreenStatus
}

export interface RoomView {
  sig: string
  group: Group
  screens: ScreenView[]
  /** Dobradiça da porta: rotation.y 0 = fechada, positivo abre para dentro da sala. */
  door: Group
  /** Onde fica o vão da porta (centro, no chão). */
  doorAt: { x: number; z: number }
  /** Caixa da sala, listas do LOD e o estado de culling/nível. */
  lod: RoomLod
  /** Onde fica cada móvel (o mesmo de furniture.ts): janelas, porta, tapete… */
  furniture: RoomFurniture
  /** Luminárias de pé: cúpula e lâmpada (apagar = trocar o material). */
  lamps: Array<{ shade: Mesh; bulb: Mesh }>
  /** O céu de cada janela. */
  skies: Mesh[]
  /** Pilha de papéis por mesa (contexto usado do dono). */
  piles: PaperPiles
  /** Esconde a cadeira da mesa `index` (foco no monitor); null mostra todas. */
  hideChair(index: number | null): void
  dispose(): void
}

export function roomSig(r: RoomLayout): string {
  return `${r.x},${r.z},${r.depth},${r.desks.length},${r.name},${r.icon ?? ''}`
}

const dummy = new Object3D()
const ZERO = new Matrix4().makeScale(0, 0, 0)

function box(kit: Kit, parent: Object3D, mat: Material, w: number, h: number, d: number, x: number, y: number, z: number, cast = false): Mesh {
  const m = new Mesh(kit.geo.box, mat)
  m.scale.set(w, h, d)
  m.position.set(x, y, z)
  m.castShadow = cast
  m.receiveShadow = true
  parent.add(m)
  return m
}

type Place = { x: number; y: number; z: number; sx: number; sy: number; sz: number; ry?: number; rz?: number; color?: Color }

function instanced(parent: Object3D, geo: BufferGeometry, mat: Material, places: Place[], cast = true): InstancedMesh {
  const im = new InstancedMesh(geo, mat, Math.max(1, places.length))
  im.count = places.length
  places.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z)
    dummy.rotation.set(0, p.ry ?? 0, p.rz ?? 0)
    dummy.scale.set(p.sx, p.sy, p.sz)
    dummy.updateMatrix()
    im.setMatrixAt(i, dummy.matrix)
    if (p.color) im.setColorAt(i, p.color)
  })
  im.instanceMatrix.needsUpdate = true
  if (im.instanceColor) im.instanceColor.needsUpdate = true
  // Esfera sobre TODAS as instâncias (com todas as cadeiras): esconder uma depois só a deixa folgada.
  im.computeBoundingSphere()
  im.castShadow = cast
  im.receiveShadow = true
  parent.add(im)
  return im
}

function plant(kit: Kit, g: Group, x: number, z: number, scale: number): void {
  const p = tagLod(new Group(), 'small')
  p.position.set(x, 0, z)
  p.scale.setScalar(scale)
  const pot = new Mesh(kit.geo.cyl, kit.mat.pot)
  pot.scale.set(0.34, 0.36, 0.34)
  pot.position.y = 0.18
  pot.castShadow = true
  const soil = tagLod(new Mesh(kit.geo.cyl, kit.mat.soil), 'detail')
  soil.scale.set(0.3, 0.02, 0.3)
  soil.position.y = 0.36
  p.add(pot, soil)
  for (const [sx, sy, x2, y2, z2, dark] of [
    [0.48, 0.55, 0, 0.64, 0, false],
    [0.34, 0.42, 0.13, 0.9, 0.05, true],
    [0.3, 0.34, -0.12, 0.84, -0.08, true]
  ] as const) {
    const leaf = tagLod(new Mesh(kit.geo.leaf, dark ? kit.mat.leafDark : kit.mat.leaf), 'detail')
    leaf.scale.set(sx, sy, sx)
    leaf.position.set(x2, y2, z2)
    leaf.castShadow = true
    p.add(leaf)
  }
  g.add(p)
}

function floorLamp(kit: Kit, g: Group, x: number, z: number): { shade: Mesh; bulb: Mesh } {
  const lamp = tagLod(new Group(), 'small')
  g.add(lamp)
  box(kit, lamp, kit.mat.metal, 0.3, 0.03, 0.3, x, 0.015, z)
  const pole = new Mesh(kit.geo.cyl, kit.mat.metal)
  pole.scale.set(0.03, 1.4, 0.03)
  pole.position.set(x, 0.7, z)
  pole.castShadow = true
  const shade = new Mesh(kit.geo.cone, kit.mat.shade)
  shade.scale.set(0.36, 0.28, 0.36)
  shade.position.set(x, 1.46, z)
  const bulb = tagLod(new Mesh(kit.geo.leaf, kit.mat.bulb), 'detail')
  bulb.scale.setScalar(0.08)
  bulb.position.set(x, 1.38, z)
  lamp.add(pole, shade, bulb)
  return { shade, bulb }
}

function windowAt(kit: Kit, g: Group, x: number, z: number): Mesh {
  box(kit, g, kit.mat.windowFrame, 1.5, 0.9, 0.05, x, 1.12, z + 0.085)
  const sky = new Mesh(kit.geo.plane, kit.mat.sky)
  sky.scale.set(1.36, 0.76, 1)
  sky.position.set(x, 1.12, z + 0.112)
  const glass = tagLod(new Mesh(kit.geo.plane, kit.mat.glass), 'detail')
  glass.scale.set(1.36, 0.76, 1)
  glass.position.set(x, 1.12, z + 0.118)
  g.add(sky, glass)
  tagLod(box(kit, g, kit.mat.windowFrame, 0.04, 0.76, 0.02, x, 1.12, z + 0.122), 'small')
  tagLod(box(kit, g, kit.mat.windowFrame, 1.36, 0.04, 0.02, x, 1.12, z + 0.122), 'small')
  tagLod(box(kit, g, kit.mat.windowFrame, 1.62, 0.04, 0.16, x, 0.65, z + 0.13), 'small')
  return sky
}

function corkboard(kit: Kit, g: Group, x: number, z: number, seed: number): void {
  box(kit, g, kit.mat.corkFrame, 1.6, 0.95, 0.04, x, 1.1, z + 0.08)
  const cork = new Mesh(kit.geo.plane, kit.mat.cork)
  cork.scale.set(1.5, 0.85, 1)
  cork.position.set(x, 1.1, z + 0.102)
  g.add(cork)
  const r = rng(seed)
  const colors = [0xfff27a, 0xffb3c7, 0x9ee6ff, 0xb8f5a0, 0xffc98a].map((c) => new Color(c))
  const notes: Place[] = []
  for (let col = 0; col < 3; col++) {
    const n = 2 + Math.floor(r() * 2)
    for (let k = 0; k < n; k++) {
      notes.push({
        x: x - 0.48 + col * 0.48 + (r() - 0.5) * 0.06,
        y: 1.36 - k * 0.24 + (r() - 0.5) * 0.03,
        z: z + 0.11,
        sx: 0.2,
        sy: 0.18,
        sz: 0.006,
        rz: (r() - 0.5) * 0.25,
        color: colors[Math.floor(r() * colors.length)]
      })
    }
  }
  tagLod(instanced(g, kit.geo.box, kit.mat.note, notes, false), 'detail')
}

function bookshelf(kit: Kit, g: Group, x: number, z: number, seed: number): void {
  const zc = z + 0.3
  box(kit, g, kit.mat.shelf, 0.04, 1.5, 0.36, x - 0.68, 0.75, zc, true)
  box(kit, g, kit.mat.shelf, 0.04, 1.5, 0.36, x + 0.68, 0.75, zc, true)
  box(kit, g, kit.mat.shelf, 1.4, 1.5, 0.02, x, 0.75, z + 0.13)
  for (const y of [0.04, 0.4, 0.76, 1.12, 1.48]) box(kit, g, kit.mat.shelf, 1.36, 0.03, 0.34, x, y, zc, y > 1)
  const r = rng(seed)
  const palette = [0x8e3b46, 0x2f5d8a, 0xd9a441, 0x3d7a57, 0x6c4f8f, 0xe8e2d0, 0x2b2b2b].map((c) => new Color(c))
  const books: Place[] = []
  for (const y of [0.04, 0.4, 0.76, 1.12]) {
    let bx = x - 0.62
    while (bx < x + 0.55) {
      const w = 0.06 + r() * 0.05
      if (r() < 0.12) {
        bx += w + 0.05
        continue
      }
      const h = 0.2 + r() * 0.1
      books.push({ x: bx + w / 2, y: y + 0.015 + h / 2, z: zc, sx: w - 0.006, sy: h, sz: 0.24, rz: r() < 0.08 ? 0.18 : 0, color: palette[Math.floor(r() * palette.length)] })
      bx += w
    }
  }
  tagLod(instanced(g, kit.geo.box, kit.mat.book, books, false), 'detail')
}

/** Balcão do café encostado na parede da direita, máquina de frente para a sala (-X). */
function coffeeStation(kit: Kit, g: Group, x: number, z: number): void {
  const s = new Group()
  s.position.set(x, 0, z)
  s.rotation.y = -Math.PI / 2
  g.add(s)
  box(kit, s, kit.mat.shelf, 0.9, 0.85, 0.5, 0, 0.425, 0, true)
  tagLod(box(kit, s, kit.mat.baseboard, 0.92, 0.03, 0.52, 0, 0.865, 0), 'small')
  // x local vira z do mundo: a máquina fica MACHINE_OFFSET para o fundo da sala.
  const mx = -MACHINE_OFFSET
  const machine = tagLod(new Group(), 'small')
  s.add(machine)
  box(kit, machine, kit.mat.coffee, 0.34, 0.42, 0.3, mx, 1.09, -0.04, true)
  box(kit, machine, kit.mat.steel, 0.36, 0.04, 0.32, mx, 1.32, -0.04)
  // Bico, bandeja e LEDs: detalhe.
  for (const [w, h, d, bx, by, bz, mat] of [
    [0.07, 0.06, 0.07, mx, 1.0, 0.13, kit.mat.steel],
    [0.22, 0.02, 0.12, mx, 0.89, 0.14, kit.mat.steel],
    [0.03, 0.03, 0.01, mx + 0.1, 1.24, 0.115, kit.mat.redLed],
    [0.03, 0.03, 0.01, mx + 0.05, 1.24, 0.115, kit.mat.greenLed]
  ] as const) {
    tagLod(box(kit, machine, mat, w, h, d, bx, by, bz), 'detail')
  }
  for (const dx of [0.2, 0.32]) {
    const mug = tagLod(new Mesh(kit.geo.cyl, kit.mat.mug), 'detail')
    mug.scale.set(0.08, 0.1, 0.08)
    mug.position.set(dx, 0.93, 0.05)
    s.add(mug)
  }
}

/** Pufe do cochilo: um feijão gordo com encosto, virado para a câmera. */
function pufe(kit: Kit, g: Group, x: number, z: number): void {
  const k = PUFE_RADIUS / 0.15
  const seat = new Mesh(kit.geo.head, kit.mat.pufe)
  seat.scale.set(k, k * 0.55, k)
  seat.position.set(x, 0.17, z)
  seat.castShadow = true
  seat.receiveShadow = true
  const back = new Mesh(kit.geo.head, kit.mat.pufe)
  back.scale.set(k * 0.85, k * 0.75, k * 0.45)
  back.position.set(x, 0.3, z - 0.22)
  back.castShadow = true
  g.add(seat, back)
}

/** Batente na parede da esquerda e a folha (na dobradiça), fechada por padrão. */
function door(kit: Kit, g: Group, f: RoomFurniture): Group {
  const { x, z, width } = f.door
  const z0 = z - width / 2
  const z1 = z + width / 2
  box(kit, g, kit.mat.wallCap, 0.16, DOOR_HEIGHT, 0.08, x, DOOR_HEIGHT / 2, z0 - 0.04, true)
  box(kit, g, kit.mat.wallCap, 0.16, DOOR_HEIGHT, 0.08, x, DOOR_HEIGHT / 2, z1 + 0.04, true)
  box(kit, g, kit.mat.wallCap, 0.16, 0.1, width + 0.16, x, DOOR_HEIGHT + 0.05, z, true)
  const hinge = new Group()
  hinge.position.set(x, 0, z0)
  hinge.name = 'door'
  g.add(hinge)
  box(kit, hinge, kit.mat.door, 0.05, DOOR_HEIGHT - 0.04, width - 0.04, 0, DOOR_HEIGHT / 2, width / 2, true)
  tagLod(box(kit, hinge, kit.mat.steel, 0.09, 0.05, 0.05, 0, 0.95, width - 0.12), 'detail')
  return hinge
}

export function buildRoom(kit: Kit, r: RoomLayout, onDirty: () => void): RoomView {
  const g = new Group()
  const { x, z, width: w, depth: d } = r
  const cx = x + w / 2
  const seed = Math.round(Math.abs(x * 31 + z * 17)) + 1

  // Piso: UV na escala da sala para as tábuas repetirem a cada 2 m.
  const floorGeo = new PlaneGeometry(w, d)
  const uv = floorGeo.attributes.uv
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 2), uv.getY(i) * (d / 2))
  const floor = new Mesh(floorGeo, kit.mat.floor)
  floor.rotation.x = -Math.PI / 2
  floor.position.set(cx, 0, z + d / 2)
  floor.receiveShadow = true
  g.add(floor)

  // Paredes: fundo alto, laterais baixas (a câmera vê por cima), rodapé e acabamento.
  // A da esquerda tem o vão da porta.
  const f = roomFurniture(r)
  box(kit, g, kit.mat.wall, w, BACK_WALL_H, 0.12, cx, BACK_WALL_H / 2, z, true)
  box(kit, g, kit.mat.wallCap, w + 0.04, 0.05, 0.16, cx, BACK_WALL_H + 0.025, z)
  const doorZ0 = f.door.z - f.door.width / 2
  const doorZ1 = f.door.z + f.door.width / 2
  for (const [wx, z0, z1] of [
    [x + w, z, z + d],
    [x, z, doorZ0],
    [x, doorZ1, z + d]
  ]) {
    box(kit, g, kit.mat.wall, 0.12, SIDE_WALL_H, z1 - z0, wx, SIDE_WALL_H / 2, (z0 + z1) / 2, true)
    box(kit, g, kit.mat.wallCap, 0.16, 0.04, z1 - z0, wx, SIDE_WALL_H + 0.02, (z0 + z1) / 2)
    tagLod(box(kit, g, kit.mat.baseboard, 0.03, 0.1, z1 - z0, wx + (wx === x ? 0.075 : -0.075), 0.05, (z0 + z1) / 2), 'small')
  }
  tagLod(box(kit, g, kit.mat.baseboard, w - 0.12, 0.1, 0.03, cx, 0.05, z + 0.075), 'small')
  const hinge = door(kit, g, f)

  const skies = f.windows.map((win) => windowAt(kit, g, win.x, win.z))
  corkboard(kit, g, f.board.x, f.board.z, seed)
  bookshelf(kit, g, f.shelf.x, f.shelf.z, seed + 1)
  for (const p of f.plants) plant(kit, g, p.x, p.z, p.scale)
  const lamps = f.lamps.map((l) => floorLamp(kit, g, l.x, l.z))
  coffeeStation(kit, g, f.coffee.x, f.coffee.z)
  const rug = new Mesh(kit.geo.plane, kit.mat.rug)
  rug.rotation.x = -Math.PI / 2
  rug.scale.set(f.rug.w, f.rug.d, 1)
  rug.position.set(f.rug.x, 0.006, f.rug.z)
  rug.receiveShadow = true
  g.add(rug)
  pufe(kit, g, f.pufe.x, f.pufe.z)

  // Placa do projeto: moldura, sombra e face, levemente inclinada para a câmera.
  const sign: SignTexture = createSignTexture(r.name, r.icon, r.id, kit.anisotropy, onDirty)
  const signMat = new MeshBasicMaterial({ map: sign.texture })
  const sg = new Group()
  sg.position.set(cx, 1.15, z + 0.2)
  sg.rotation.x = -0.26
  const SW = 3.2
  const SH = SW / sign.aspect
  const shadow = new Mesh(kit.geo.plane, kit.mat.signShadow)
  shadow.scale.set(SW + 0.16, SH + 0.16, 1)
  shadow.position.set(0.05, -0.06, -0.06)
  const frame = new Mesh(kit.geo.box, kit.mat.signFrame)
  frame.scale.set(SW + 0.12, SH + 0.12, 0.06)
  frame.castShadow = true
  const face = new Mesh(kit.geo.plane, signMat)
  face.scale.set(SW, SH, 1)
  face.position.z = 0.032
  sg.add(shadow, frame, face)
  g.add(sg)

  // Móveis por mesa (instanciados) + telas (uma Mesh por mesa: textura própria).
  const DH = DESK_HEIGHT
  const P = (px: number, py: number, pz: number, sx: number, sy: number, sz: number): Place => ({ x: px, y: py, z: pz, sx, sy, sz })
  const tops: Place[] = []
  const legs: Place[] = []
  const bezels: Place[] = []
  const stands: Place[] = []
  const keys: Place[] = []
  const mugs: Place[] = []
  const seats: Place[] = []
  const backs: Place[] = []
  const posts: Place[] = []
  const bases: Place[] = []
  const screens: ScreenView[] = []
  for (const desk of r.desks) {
    const mz = desk.z - MONITOR_BACK
    tops.push(P(desk.x, DH, desk.z, 1.6, 0.06, 0.8))
    legs.push(P(desk.x - 0.75, DH / 2, desk.z, 0.06, DH, 0.7), P(desk.x + 0.75, DH / 2, desk.z, 0.06, DH, 0.7))
    bezels.push(P(desk.x, MONITOR_Y, mz, kit.geo.screen.parameters.width + 0.06, kit.geo.screen.parameters.height + 0.06, 0.04))
    stands.push(P(desk.x, (MONITOR_Y + DH) / 2, mz - 0.03, 0.06, MONITOR_Y - DH, 0.06), P(desk.x, DH + 0.04, mz - 0.02, 0.28, 0.02, 0.2))
    keys.push(P(desk.x, DH + 0.045, desk.z + 0.2, 0.46, 0.025, 0.15))
    mugs.push(P(desk.x + 0.6, DH + 0.08, desk.z + 0.1, 0.08, 0.1, 0.08))
    seats.push(P(desk.x, SEAT_Y, desk.z + 0.85, 0.5, 0.08, 0.5))
    backs.push(P(desk.x, SEAT_Y + 0.29, desk.z + 1.1, 0.5, 0.5, 0.06))
    posts.push(P(desk.x, SEAT_Y / 2, desk.z + 0.85, 0.06, SEAT_Y - 0.04, 0.06))
    bases.push(P(desk.x, 0.03, desk.z + 0.85, 0.5, 0.04, 0.5))
    const screen = new Mesh(kit.geo.screen, kit.mat.screenOff)
    screen.position.set(desk.x, MONITOR_Y, mz + 0.026)
    screen.userData.charKey = null
    g.add(screen)
    screens.push({ mesh: screen, state: 'off', on: null, page: null, accent: '', status: 'idle' })
  }
  instanced(g, kit.geo.box, kit.mat.deskTop, tops)
  instanced(g, kit.geo.box, kit.mat.deskLeg, legs)
  instanced(g, kit.geo.box, kit.mat.frame, bezels)
  tagLod(instanced(g, kit.geo.box, kit.mat.frame, stands), 'small')
  tagLod(instanced(g, kit.geo.box, kit.mat.keyboard, keys, false), 'small')
  tagLod(instanced(g, kit.geo.cyl, kit.mat.mug, mugs, false), 'detail')
  const chairs = [
    instanced(g, kit.geo.box, kit.mat.chairSeat, seats),
    instanced(g, kit.geo.box, kit.mat.chairSeat, backs),
    tagLod(instanced(g, kit.geo.cyl, kit.mat.chair, posts), 'small'),
    tagLod(instanced(g, kit.geo.cyl, kit.mat.chair, bases), 'small')
  ]
  const chairPlaces = [seats, backs, posts, bases]
  const piles = createPaperPiles(kit, r, g)
  let hidden: number | null = null

  const setChair = (index: number, show: boolean): void => {
    chairs.forEach((im, k) => {
      const p = chairPlaces[k][index]
      if (!p) return
      if (show) {
        dummy.position.set(p.x, p.y, p.z)
        dummy.rotation.set(0, 0, 0)
        dummy.scale.set(p.sx, p.sy, p.sz)
        dummy.updateMatrix()
        im.setMatrixAt(index, dummy.matrix)
      } else {
        im.setMatrixAt(index, ZERO)
      }
      im.instanceMatrix.needsUpdate = true
    })
  }

  return {
    sig: roomSig(r),
    group: g,
    screens,
    door: hinge,
    doorAt: { x: f.door.x, z: f.door.z },
    lod: collectRoomLod(g, roomBox(x, z, w, d)),
    furniture: f,
    lamps,
    skies,
    piles,
    hideChair(index) {
      if (index === hidden) return
      if (hidden !== null) setChair(hidden, true)
      hidden = index
      if (index !== null) setChair(index, false)
    },
    dispose() {
      g.removeFromParent()
      floorGeo.dispose()
      sign.dispose()
      signMat.dispose()
      g.traverse((o) => {
        if (o instanceof InstancedMesh) o.dispose()
      })
      for (const s of screens) disposeScreenOn(s)
    }
  }
}

export function disposeScreenOn(s: ScreenView): void {
  if (!s.on) return
  s.on.mon.texture.dispose()
  s.on.mat.dispose()
  s.on = null
}
