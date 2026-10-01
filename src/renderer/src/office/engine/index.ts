// API pública do motor do escritório. Quem monta o escritório importa daqui.

export * from './types'
export * from './constants'
export { OfficeState, type IdleBehavior } from './officeState'
export type { AddAgentOptions } from './agents'
export { characterPose, isSeated } from './characters'
export { findPath, getWalkableTiles, isWalkable, tileKey } from './tileMap'
export { anchorTile, closestFreeSeat, pickSeat, type SeatRequest } from './seatPlacement'
export { validateLayout, roomAt } from './world'
export {
  centerOn,
  clampPan,
  clampZoom,
  fitZoom,
  followStep,
  mapOffset,
  panToCenter,
  screenToWorld,
  worldToScreen,
  type MapOffset,
  type MapSize,
  type Point,
  type Size,
  type TileRect
} from './camera'
export { createGameLoop, type GameLoop, type GameLoopCallbacks } from './gameLoop'
export { getCachedSprite, getOutlineSprite } from './spriteCache'
export { OfficeRenderer, type RenderSource, type RenderView } from './renderer'
export { buildBubbleItems, buildSceneItems, type SceneItem, type SceneSource } from './sceneLayers'
