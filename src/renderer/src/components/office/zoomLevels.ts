/**
 * Zoom em níveis: prédio → sala → mesa → tela. Puro: recebe viewport (pixels
 * de dispositivo), mapa e foco; devolve zoom inteiro e pan. Usa só a câmera
 * do motor (fitZoom/centerOn/panToCenter/clampPan).
 */
import {
  centerOn,
  clampPan,
  clampZoom,
  fitZoom,
  panToCenter,
  TILE_SIZE,
  type MapSize,
  type Point,
  type RoomDef,
  type Size
} from '../../office/engine'

export type ZoomLevel = 'predio' | 'sala' | 'mesa' | 'tela'
export const ZOOM_LEVELS: readonly ZoomLevel[] = ['predio', 'sala', 'mesa', 'tela']

export const LEVEL_LABEL: Readonly<Record<ZoomLevel, string>> = {
  predio: 'Prédio',
  sala: 'Sala',
  mesa: 'Mesa',
  tela: 'Tela'
}

/** Área (em tiles) que cada nível tenta encaixar em volta do foco. */
const MESA_TILES = { w: 9, h: 7 }
const TELA_TILES = { w: 4, h: 3 }

export interface LevelFocus {
  /** Sala em foco (nível sala, e reserva dos níveis mais próximos). */
  room: RoomDef | null
  /** Ponto de mundo em foco (personagem/mesa); null = centro da sala. */
  point: Point | null
}

export interface LevelView {
  zoom: number
  pan: Point
}

export function stepLevel(level: ZoomLevel, delta: 1 | -1): ZoomLevel {
  const i = ZOOM_LEVELS.indexOf(level) + delta
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i))]
}

function roomCenter(room: RoomDef): Point {
  return { x: (room.col + room.w / 2) * TILE_SIZE, y: (room.row + room.h / 2) * TILE_SIZE }
}

/** Menor fração de zoom do prédio — e o passo dela, para o cache de sprites
 *  (um por zoom) não crescer a cada pixel de redimensionamento da aba. */
const OVERVIEW_STEP = 1 / 8

/**
 * Zoom do nível prédio. O plano pede que afastar mostre o prédio INTEIRO, e com
 * 5 salas lado a lado nem o zoom inteiro mínimo (1) cabe numa aba de ~480 px.
 * Só aqui o zoom pode ser fracionário: a visão geral serve para achar a sala, não
 * para ler pixel; os níveis de perto continuam inteiros e nítidos.
 */
export function overviewZoom(viewport: Size, map: MapSize): number {
  const ratio = Math.min(
    viewport.width / (Math.max(1, map.cols) * TILE_SIZE),
    viewport.height / (Math.max(1, map.rows) * TILE_SIZE)
  )
  if (ratio >= 1) return fitZoom(viewport, { col: 0, row: 0, w: map.cols, h: map.rows })
  return Math.max(OVERVIEW_STEP, Math.floor(ratio / OVERVIEW_STEP) * OVERVIEW_STEP)
}

export function viewForLevel(level: ZoomLevel, viewport: Size, map: MapSize, focus: LevelFocus): LevelView {
  const whole = { col: 0, row: 0, w: map.cols, h: map.rows }
  const predioZoom = overviewZoom(viewport, map)
  let zoom: number
  let pan: Point
  if (level === 'predio' || (!focus.room && !focus.point)) {
    zoom = predioZoom
    pan = centerOn(whole, map, zoom)
  } else if (level === 'sala' || (!focus.point && level !== 'tela' && level !== 'mesa')) {
    const room = focus.room!
    zoom = Math.max(predioZoom, fitZoom(viewport, room))
    pan = centerOn(room, map, zoom)
  } else {
    const salaZoom = focus.room ? fitZoom(viewport, focus.room) : predioZoom
    const p = focus.point ?? roomCenter(focus.room!)
    const area = level === 'mesa' ? MESA_TILES : TELA_TILES
    const fit = fitZoom(viewport, { col: 0, row: 0, ...area })
    const floor = level === 'mesa' ? salaZoom + 1 : salaZoom + 2
    zoom = clampZoom(Math.max(fit, floor))
    // Na tela, o monitor fica um tile acima dos pés do personagem.
    const target = level === 'tela' ? { x: p.x, y: p.y - TILE_SIZE } : p
    pan = panToCenter(target, map, zoom)
  }
  return { zoom, pan: clampPan(pan, viewport, map, zoom) }
}
