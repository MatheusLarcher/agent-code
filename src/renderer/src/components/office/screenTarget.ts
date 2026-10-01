/**
 * Geometria da tela de código (monitor da mesa), separada do OfficeView: quem
 * a tela mostra, onde fica o monitor no mundo e o retângulo em pixels CSS.
 * Funções puras sobre o OfficeState; o view só guarda o alvo e chama aqui.
 */
import { TILE_SIZE, worldToScreen, type MapOffset, type OfficeState, type Point } from '../../office/engine'
import type { ZoomLevel } from './zoomLevels'

/** Quem a tela do monitor mostra: o personagem (se houver) e a mesa onde ela ancora. */
export interface ScreenTarget {
  charId: number | null
  deskUid: string | null
}

/** Retângulo do monitor em pixels CSS dentro do canvas. */
export interface ScreenRect {
  x: number
  y: number
  w: number
  h: number
}

/** Mesa (uid) do assento do personagem, se ele estiver numa. */
export function deskOf(state: OfficeState, charId: number | null): string | null {
  if (charId === null) return null
  const seatId = state.getCharacter(charId)?.seatId
  return (seatId && state.seats.get(seatId)?.deskUid) || null
}

/** Alvo da tela para o nível: só no 'tela', com personagem em foco ou mesa escolhida. */
export function nextScreenTarget(
  state: OfficeState,
  level: ZoomLevel,
  current: ScreenTarget | null,
  desk: string | null
): ScreenTarget | null {
  if (level !== 'tela') return null
  const id = state.cameraFollowId ?? state.selectedAgentId
  if (id !== null && state.getCharacter(id)) return { charId: id, deskUid: deskOf(state, id) }
  const d = desk ?? current?.deskUid
  return d ? { charId: null, deskUid: d } : null
}

/** Mesmo alvo (ou os dois ausentes)? */
export function sameTarget(a: ScreenTarget | null, b: ScreenTarget | null): boolean {
  if (!a || !b) return !a === !b
  return a.charId === b.charId && a.deskUid === b.deskUid
}

/** Mesa cujo monitor (o footprint e um tile acima) está sob o ponto. */
export function monitorAt(state: OfficeState, p: Point): string | null {
  for (const f of state.layout.furniture) {
    if (f.kind !== 'mesa') continue
    const x0 = f.col * TILE_SIZE
    const y0 = (f.row - 1) * TILE_SIZE
    if (p.x >= x0 && p.x < x0 + f.w * TILE_SIZE && p.y >= y0 && p.y < (f.row + f.h) * TILE_SIZE) return f.uid
  }
  return null
}

/** Retângulo do monitor do alvo (CSS px), ou null sem alvo/ancoragem. */
export function screenRectFor(
  state: OfficeState,
  t: ScreenTarget | null,
  offset: MapOffset,
  zoom: number,
  dpr: number
): ScreenRect | null {
  if (!t) return null
  const f = t.deskUid ? state.layout.furniture.find((d) => d.uid === t.deskUid) : undefined
  let world: { x: number; y: number; w: number; h: number }
  if (f) {
    world = { x: f.col * TILE_SIZE, y: (f.row - 1) * TILE_SIZE, w: f.w * TILE_SIZE, h: TILE_SIZE }
  } else {
    const ch = t.charId !== null ? state.getCharacter(t.charId) : undefined
    if (!ch) return null
    world = { x: ch.x - TILE_SIZE / 2, y: ch.y - 2 * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE }
  }
  const p = worldToScreen({ x: world.x, y: world.y }, offset, zoom)
  return { x: p.x / dpr, y: p.y / dpr, w: (world.w * zoom) / dpr, h: (world.h * zoom) / dpr }
}
