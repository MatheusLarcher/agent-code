/**
 * O escritório 3D (three), montado UMA vez a partir de officePlan.ts — a
 * mesma fonte da grade de navegação (furniture.ts). Por dentro, ZONAS (as 4
 * ilhas, a praça, o lounge, a sala de reunião e a casca): cada uma tem o seu
 * grupo, a sua caixa e o seu estado de culling/LOD (roomLod.ts). A cena corta e
 * escolhe o nível por zona; nada é fundido entre zonas.
 *
 * Quem desenha cada parte: decorShell.ts (piso, paredes, vidro com o céu,
 * trilhas), decorIslands.ts (estações, cadeiras, telas e pilhas de papel),
 * decorBack.ts (lounge e sala de reunião com a TV) e decorWall.ts (café,
 * Memórias, porta, floreira, console da Central e plantas). A mobília estática
 * de cada zona é fundida por material (decorUtil.mergeStatic). O kanban do
 * Quadro real não mora aqui: a cena o prende ao grupo da praça (board/boards.ts).
 *
 * LOD (roomLod.ts): detalhes levam userData.lod = 'detail' e somem no MÉDIO;
 * decoração pequena leva 'small' e some no LONGE.
 *
 * Energia (blackout.ts): a sala expõe as luminárias (cúpula e lâmpada, para
 * apagar trocando o material), o céu atrás do vidro (luar no apagão) e a pilha
 * de papéis de cada mesa (o contexto usado do dono, paperPile.ts).
 */
import { Box3, Group, InstancedMesh, Vector3, type BufferGeometry, type Mesh, type MeshBasicMaterial, type Object3D } from 'three'
import { buildLounge, buildMeeting, type Lamp } from './decorBack'
import { buildIsland } from './decorIslands'
import { buildShell } from './decorShell'
import { mergeStatic } from './decorUtil'
import { buildWalls } from './decorWall'
import { buildWallClock } from './wallClock'
import { roomFurniture, type RoomFurniture } from './furniture'
import type { Kit, ScreenStatus } from './kit'
import type { RoomLayout } from './layout'
import type { MonitorTexture, ScreenPage } from './monitorTexture'
import { ISLANDS, OFFICE, ZONE_IDS, ZONES, type ZoneId } from './officePlan'
import type { PaperPiles } from './paperPile'
import { buildPlaques, type Plaques } from './plaques'
import { collectRoomLod, type RoomLod } from './roomLod'

export { SEAT_TOP } from './chairModel'

export interface ScreenView {
  mesh: Mesh
  state: 'off' | 'saver' | 'on'
  /** Textura da tela acesa (na resolução do nível); null apagada, protetor ou LONGE. */
  on: { mat: MeshBasicMaterial; mon: MonitorTexture } | null
  /** O que mostrar acesa: guardado mesmo com a zona fora da tela (desenha quando voltar). */
  page: ScreenPage | null
  accent: string
  /** Cor do bloco no LONGE. */
  status: ScreenStatus
  /** A zona da tela (culling e nível). */
  lod: RoomLod
  zone: ZoneId
}

export interface ZoneView {
  id: ZoneId
  group: Group
  /** Caixa da zona, listas do LOD e o estado de culling/nível. */
  lod: RoomLod
}

export interface RoomView {
  sig: string
  group: Group
  zones: ZoneView[]
  zone(id: ZoneId): ZoneView
  /** As 16 telas das mesas (índice = mesa). */
  screens: ScreenView[]
  /** A tela do console da Central (o monitor dela). */
  consoleScreen: ScreenView
  /** Alvos de clique fixos da sala (a estante de Memórias). */
  pickables: Object3D[]
  /** Dobradiça da porta: rotation.y 0 = fechada, positivo abre para dentro. */
  door: Group
  /** Onde fica o vão da porta (centro, no chão) e a zona dela. */
  doorAt: { x: number; z: number }
  doorZone: ZoneView
  /** Onde fica cada móvel (furniture.ts): porta, kanban, TV, pista da festa… */
  furniture: RoomFurniture
  /** Luminárias (cúpula e lâmpada) e a zona de cada uma. */
  lamps: Array<Lamp & { zone: ZoneId }>
  /** O céu atrás da parede de vidro. */
  skies: Mesh[]
  /** A tela da TV da sala de reunião. */
  tv: Mesh
  /** Pilha de papéis por mesa (contexto usado do dono). */
  piles: PaperPiles
  /** Placa no chão de cada ilha reservada e plaquinha de cada mesa ocupada. */
  plaques: Plaques
  /** Esconde a cadeira da mesa `index` (foco no monitor); null mostra todas. */
  hideChair(index: number | null): void
  /** Recua a cadeira da mesa `index` em `pull` m (0 = no lugar): sentar e levantar. */
  pullChair(index: number, pull: number): void
  /** Compat: o LOD da casca (o escritório todo). */
  lod: RoomLod
  dispose(): void
}

/** O escritório é fixo: a assinatura não muda com os donos das mesas. */
export function roomSig(r: RoomLayout): string {
  return `${r.id}|${r.desks.length}`
}

/** Folga das caixas das zonas: quem está em pé na borda, as cabeças e os balões. */
const EDGE = 0.3
const TOP = 3.0

function zoneBox(id: ZoneId): Box3 {
  const rect = id === 'shell' ? OFFICE : ZONES.find((z) => z.id === id)!.rect
  const out = id === 'shell' || id === 'island1' ? 1.4 : EDGE
  return new Box3(new Vector3(rect.x0 - EDGE, 0, rect.z0 - EDGE), new Vector3(rect.x1 + out, TOP, rect.z1 + EDGE))
}

export function buildRoom(kit: Kit, r: RoomLayout, onDirty: () => void): RoomView {
  const g = new Group()
  g.name = 'office'
  const parts = new Map<ZoneId, { group: Group; statics: Group }>()
  for (const id of ZONE_IDS) {
    const group = new Group()
    group.name = `zone:${id}`
    const statics = new Group()
    group.add(statics)
    g.add(group)
    parts.set(id, { group, statics })
  }
  const zp = (id: ZoneId): { group: Group; statics: Group } => parts.get(id)!

  const shell = buildShell(kit, zp('shell').group, zp('shell').statics)
  const lounge = buildLounge(kit, zp('lounge').group, zp('lounge').statics)
  const meeting = buildMeeting(kit, zp('meeting').group, zp('meeting').statics)
  const walls = buildWalls(kit, zp)
  const islands = ISLANDS.map((isl) => {
    const desks = r.desks.filter((d) => d.island === isl.index)
    return { desks, parts: buildIsland(kit, isl.index, desks, zp(isl.zone).group, zp(isl.zone).statics) }
  })
  const plaques = buildPlaques(kit, zp, onDirty)
  // O relógio de parede (entre os quadros do lounge e o kanban): hora local, redesenhado a cada minuto.
  const clock = buildWallClock(kit, zp('lounge').group, zp('lounge').statics, onDirty)

  // Funde o estático de cada zona (por material) e monta o LOD dela.
  const geos: BufferGeometry[] = [...shell.geos, ...islands.flatMap((i) => i.parts.geos)]
  const zones: ZoneView[] = ZONE_IDS.map((id) => {
    const { group, statics } = zp(id)
    geos.push(...mergeStatic(group, statics))
    return { id, group, lod: collectRoomLod(group, zoneBox(id)) }
  })
  const zone = (id: ZoneId): ZoneView => zones.find((z) => z.id === id)!

  const screens: ScreenView[] = []
  for (const isl of islands) {
    isl.desks.forEach((d, i) => {
      const z = zone(ISLANDS[d.island].zone)
      screens[d.index] = { mesh: isl.parts.screens[i], state: 'off', on: null, page: null, accent: '', status: 'idle', lod: z.lod, zone: z.id }
    })
  }
  const plaza = zone('plaza')
  const consoleScreen: ScreenView = { mesh: walls.consoleScreen, state: 'off', on: null, page: null, accent: '', status: 'idle', lod: plaza.lod, zone: 'plaza' }
  const islandOf = (index: number): { parts: ReturnType<typeof buildIsland>; local: number } | null => {
    for (const isl of islands) {
      const local = isl.desks.findIndex((d) => d.index === index)
      if (local >= 0) return { parts: isl.parts, local }
    }
    return null
  }
  const pulls = new Array<number>(r.desks.length).fill(0)
  let hidden: number | null = null
  const applyChair = (index: number): void => {
    const at = islandOf(index)
    if (at) at.parts.chair(at.local, pulls[index], hidden === index)
  }
  const piles: PaperPiles = {
    mesh: islands[0].parts.piles.mesh,
    set(desk, step) {
      const at = islandOf(desk)
      at?.parts.piles.set(at.local, step)
    },
    step(desk) {
      const at = islandOf(desk)
      return at ? at.parts.piles.step(at.local) : 0
    }
  }
  const furniture = roomFurniture(r)
  const doorZone = zone(ISLANDS[1].zone)

  return {
    sig: roomSig(r),
    group: g,
    zones,
    zone,
    screens,
    consoleScreen,
    pickables: [walls.shelfPick, walls.boardPick],
    door: walls.door,
    doorAt: { x: furniture.door.x, z: furniture.door.z },
    doorZone,
    furniture,
    lamps: [...lounge.map((l) => ({ ...l, zone: 'lounge' as ZoneId })), ...meeting.lamps.map((l) => ({ ...l, zone: 'meeting' as ZoneId }))],
    skies: shell.skies,
    tv: meeting.tv,
    piles,
    plaques,
    lod: zone('shell').lod,
    hideChair(index) {
      if (index === hidden) return
      const prev = hidden
      hidden = index
      if (prev !== null) applyChair(prev)
      if (index !== null) applyChair(index)
    },
    pullChair(index, pull) {
      if (index < 0 || index >= pulls.length || pulls[index] === pull) return
      pulls[index] = pull
      applyChair(index)
    },
    dispose() {
      g.removeFromParent()
      for (const geo of geos) geo.dispose()
      walls.dispose()
      plaques.dispose()
      clock.dispose()
      g.traverse((o) => {
        if (o instanceof InstancedMesh) o.dispose()
      })
      for (const s of [...screens, consoleScreen]) disposeScreenOn(s)
    }
  }
}

export function disposeScreenOn(s: ScreenView): void {
  if (!s.on) return
  s.on.mon.texture.dispose()
  s.on.mat.dispose()
  s.on = null
}
