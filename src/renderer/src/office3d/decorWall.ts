/**
 * Parede da direita, parede de vidro e praça (three), medidas de officePlan.ts:
 *   café         balcão de carvalho de frente para dentro (−X), máquina, xícaras;
 *   Memórias     estante de carvalho virada para −X: prateleiras com fichários,
 *                impressora em cima e a placa "MEMÓRIAS" (textura própria);
 *   porta        batentes, verga e a folha na dobradiça (abre para dentro, −X);
 *   floreira     aparador baixo de carvalho com plantas junto do vidro;
 *   praça        console redondo da Central (base cream, tampo de madeira, tela
 *                inclinada — a tela é o monitor da Central — e o hub sage),
 *                tapete sage e as plantas grandes do chão.
 * Estático vai para a fusão da zona; a folha da porta e a tela do console, não.
 */
import { CanvasTexture, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, SRGBColorSpace } from 'three'
import { BOARD_H, BOARD_W, FACE_Z } from './board/boardLayout'
import { BOARD_KEY, MEMORY_SHELF_KEY } from './engineTypes'
import { box, cyl, disc, plant } from './decorUtil'
import { boardPlace, DOOR_HEIGHT, MACHINE_OFFSET } from './furniture'
import type { Kit } from './kit'
import { COFFEE, CONSOLE, DOOR, FLOOR_PLANTS, GLASS_PLANTER, MEMORY_SHELF, PLAZA_RUG, RIGHT_X, zoneAt, type ZoneId } from './officePlan'
import { tagLod } from './roomLod'
import { canvas2d } from './textures'

/** Inclinação da tela do console (a de cima vai para trás). */
export const CONSOLE_TILT = -0.27
/** Centro da tela do console (local do console). */
export const CONSOLE_SCREEN = { y: 0.8, z: -0.14, scale: 0.6 } as const

export interface WallParts {
  /** Dobradiça da porta: rotation.y 0 = fechada, positivo abre para dentro (−X). */
  door: Group
  /** A tela do console da Central. */
  consoleScreen: Mesh
  /** O alvo invisível do clique na estante de Memórias (abre o painel). */
  shelfPick: Mesh
  /** O alvo invisível do clique no kanban da parede (foca o quadro). */
  boardPick: Mesh
  /** O que é próprio (textura e material da placa), liberado no dispose. */
  dispose(): void
}

type Zones = (id: ZoneId) => { group: Group; statics: Group }

/** Balcão do café encostado na parede da direita, a máquina de frente para dentro (−X). */
function coffeeStation(kit: Kit, statics: Group): void {
  const m = kit.mat
  const s = new Group()
  s.position.set(COFFEE.x, 0, COFFEE.z)
  s.rotation.y = -Math.PI / 2
  statics.add(s)
  box(kit, s, m.shelf, 0.9, 0.85, 0.5, 0, 0.425, 0, true)
  tagLod(box(kit, s, m.cream, 0.92, 0.03, 0.52, 0, 0.865, 0), 'small')
  // x local vira z do mundo: a máquina fica MACHINE_OFFSET para o fundo do escritório.
  const mx = -MACHINE_OFFSET
  const machine = tagLod(new Group(), 'small')
  s.add(machine)
  box(kit, machine, m.coffee, 0.34, 0.42, 0.3, mx, 1.09, -0.04, true)
  box(kit, machine, m.steel, 0.36, 0.04, 0.32, mx, 1.32, -0.04)
  for (const [w, h, d, bx, by, bz, mat] of [
    [0.07, 0.06, 0.07, mx, 1.0, 0.13, m.steel],
    [0.22, 0.02, 0.12, mx, 0.89, 0.14, m.steel],
    [0.03, 0.03, 0.01, mx + 0.1, 1.24, 0.115, m.redLed],
    [0.03, 0.03, 0.01, mx + 0.05, 1.24, 0.115, m.greenLed]
  ] as const) {
    tagLod(box(kit, machine, mat, w, h, d, bx, by, bz), 'detail')
  }
  for (const dx of [0.2, 0.32]) tagLod(cyl(kit, s, m.mug, 0.08, 0.1, dx, 0.88, 0.05), 'detail')
}

/** A placa "MEMÓRIAS" (textura própria). */
function memorySign(kit: Kit): { mat: MeshLambertMaterial; texture: CanvasTexture } {
  const { canvas, ctx } = canvas2d(512, 96)
  if (ctx) {
    ctx.fillStyle = '#eceee3'
    ctx.fillRect(0, 0, 512, 96)
    ctx.fillStyle = '#77846f'
    ctx.font = '600 46px "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('MEMÓRIAS', 256, 50)
  }
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  texture.anisotropy = kit.anisotropy
  return { mat: new MeshLambertMaterial({ map: texture }), texture }
}

/** Estante de Memórias encostada na parede da direita, virada para −X. */
function memoryShelf(kit: Kit, statics: Group, signMat: MeshLambertMaterial): void {
  const m = kit.mat
  const S = MEMORY_SHELF
  const g = new Group()
  g.position.set(S.x, 0, S.z)
  g.rotation.y = -Math.PI / 2
  statics.add(g)
  // Local: x ao longo da parede (z do mundo), +z para dentro do escritório.
  box(kit, g, m.shelf, S.w, S.h, S.d, 0, S.h / 2, 0, true)
  for (const y of [0.16, 0.48, 0.8]) {
    box(kit, g, m.cream, S.w - 0.1, 0.02, 0.3, 0, y - 0.03, 0.03)
    for (let i = 0; i < 6; i++) tagLod(box(kit, g, i % 3 ? m.paper : m.sage, 0.1, 0.24, 0.12, -0.47 + i * 0.185, y + 0.1, S.d / 2 - 0.04), 'detail')
  }
  // Impressora em cima e a placa.
  box(kit, g, m.cream, 0.5, 0.16, 0.32, 0.3, S.h + 0.08, -0.02, true)
  tagLod(box(kit, g, m.charcoal, 0.38, 0.02, 0.2, 0.3, S.h + 0.17, 0), 'detail')
  const sign = new Mesh(kit.geo.plane, signMat)
  sign.scale.set(0.62, 0.12, 1)
  sign.position.set(-0.28, S.h + 0.07, S.d / 2 + 0.006)
  g.add(sign)
  box(kit, g, m.cream, 0.66, 0.15, 0.02, -0.28, S.h + 0.07, S.d / 2 - 0.006)
}

/** Batentes e verga na parede da direita; a folha na dobradiça (z1), abrindo para dentro. */
function door(kit: Kit, zone: Group, statics: Group): Group {
  const m = kit.mat
  const { x, z, width } = DOOR
  const z0 = z - width / 2
  const z1 = z + width / 2
  box(kit, statics, m.wallCap, 0.18, DOOR_HEIGHT, 0.08, x, DOOR_HEIGHT / 2, z0 - 0.04, true)
  box(kit, statics, m.wallCap, 0.18, DOOR_HEIGHT, 0.08, x, DOOR_HEIGHT / 2, z1 + 0.04, true)
  box(kit, statics, m.wallCap, 0.18, 0.08, width + 0.16, x, DOOR_HEIGHT + 0.04, z, true)
  const hinge = new Group()
  hinge.position.set(x, 0, z1)
  hinge.name = 'door'
  zone.add(hinge)
  box(kit, hinge, m.door, 0.05, DOOR_HEIGHT - 0.04, width - 0.04, 0, DOOR_HEIGHT / 2, -width / 2, true)
  tagLod(box(kit, hinge, m.steel, 0.09, 0.05, 0.05, 0, 0.95, -(width - 0.12)), 'detail')
  return hinge
}

/** Console redondo da Central sobre o tapete sage; devolve a tela (o monitor da Central). */
function centralConsole(kit: Kit, zone: Group, statics: Group): Mesh {
  const m = kit.mat
  const { x, z, r, top } = CONSOLE
  disc(kit, statics, m.rugPlaza, PLAZA_RUG.r, PLAZA_RUG.r, PLAZA_RUG.x, 0.008, PLAZA_RUG.z)
  cyl(kit, statics, m.cream, r * 1.45, top - 0.05, x, 0, z, true)
  cyl(kit, statics, m.shelf, r * 2, 0.05, x, top - 0.05, z, true)
  cyl(kit, statics, m.sage, 0.26, 0.12, x, top, z + 0.3, true)
  const g = new Group()
  g.position.set(x, CONSOLE_SCREEN.y, z + CONSOLE_SCREEN.z)
  g.rotation.x = CONSOLE_TILT
  statics.add(g)
  const w = kit.geo.screen.parameters.width * CONSOLE_SCREEN.scale
  const h = kit.geo.screen.parameters.height * CONSOLE_SCREEN.scale
  box(kit, g, m.charcoal, w + 0.06, h + 0.06, 0.035, 0, 0, 0, true)
  tagLod(box(kit, statics, m.metal, 0.05, CONSOLE_SCREEN.y - top - 0.1, 0.05, x, (CONSOLE_SCREEN.y + top - 0.1) / 2, z + CONSOLE_SCREEN.z - 0.04), 'small')
  const screen = new Mesh(kit.geo.screen, m.screenOff)
  screen.scale.set(CONSOLE_SCREEN.scale, CONSOLE_SCREEN.scale, 1)
  screen.position.set(x, CONSOLE_SCREEN.y + 0.019 * Math.sin(-CONSOLE_TILT), z + CONSOLE_SCREEN.z + 0.019 * Math.cos(CONSOLE_TILT))
  screen.rotation.x = CONSOLE_TILT
  screen.userData.charKey = null
  zone.add(screen)
  return screen
}

export function buildWalls(kit: Kit, zones: Zones): WallParts {
  const m = kit.mat
  coffeeStation(kit, zones(zoneAt(COFFEE.x, COFFEE.z)).statics)
  const sign = memorySign(kit)
  memoryShelf(kit, zones(zoneAt(MEMORY_SHELF.x, MEMORY_SHELF.z)).statics, sign.mat)
  const dz = zones(zoneAt(RIGHT_X - 0.5, DOOR.z))
  const hinge = door(kit, dz.group, dz.statics)
  // Floreira junto do vidro (atravessa duas zonas: fica na casca).
  const P = GLASS_PLANTER
  const ps = zones('shell').statics
  box(kit, ps, m.shelf, P.d, P.h, P.len, P.x, P.h / 2, P.z, true)
  for (let i = 0; i < 4; i++) plant(kit, ps, P.x, P.h, P.z - P.len / 2 + 0.35 + i * ((P.len - 0.7) / 3), 0.7)
  // Plantas grandes do chão.
  for (const p of FLOOR_PLANTS) plant(kit, zones(zoneAt(p.x, p.z)).statics, p.x, 0, p.z, p.scale)
  const plaza = zones('plaza')
  const consoleScreen = centralConsole(kit, plaza.group, plaza.statics)
  // O clique na estante de Memórias: uma caixa invisível do tamanho dela (o raio acerta; nada desenha).
  const pickMat = new MeshBasicMaterial({ visible: false })
  const shelfPick = new Mesh(kit.geo.box, pickMat)
  shelfPick.scale.set(MEMORY_SHELF.d + 0.1, MEMORY_SHELF.h + 0.6, MEMORY_SHELF.w)
  shelfPick.position.set(MEMORY_SHELF.x, (MEMORY_SHELF.h + 0.6) / 2, MEMORY_SHELF.z)
  shelfPick.userData.charKey = MEMORY_SHELF_KEY
  zones(zoneAt(MEMORY_SHELF.x, MEMORY_SHELF.z)).group.add(shelfPick)
  // O do kanban: logo atrás da face, para o papel e a pilha (na frente) ganharem o raio.
  const bp = boardPlace()
  const boardPick = new Mesh(kit.geo.box, pickMat)
  boardPick.scale.set(BOARD_W + 0.1, BOARD_H + 0.1, 0.02)
  boardPick.position.set(bp.x, bp.y, bp.z + FACE_Z - 0.03)
  boardPick.userData.charKey = BOARD_KEY
  plaza.group.add(boardPick)
  return {
    door: hinge,
    consoleScreen,
    shelfPick,
    boardPick,
    dispose() {
      sign.texture.dispose()
      sign.mat.dispose()
      pickMat.dispose()
    }
  }
}
