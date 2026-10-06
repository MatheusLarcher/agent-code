/**
 * A TV no motor: o filtro de projeto do HUD vale para ela, o placar (a TV
 * ociosa) lê o Quadro real e a energia, e o foco (`focusPoseFor`) voa até a
 * TV de frente (tvPose, sem arfagem) como voa até o monitor — e até a tela
 * inclinada do console da Central, perpendicular a ela (CONSOLE_PLANE). Só liga as pontas
 * — o que a TV mostra é decidido em projectors.ts / tvContent.ts.
 */
import type { EngineBoard } from './board/engineBoard'
import { monitorPose, screenPose, TV_PLANE, tvPose, type CameraPose, type MonitorAt, type ScreenPlane, type ViewSize } from './cameraRig'
import { CONSOLE_SCREEN, CONSOLE_TILT } from './decorWall'
import { SCREEN_H, SCREEN_W } from './kit'
import { CONSOLE, MEMORY_SHELF } from './officePlan'
import type { EngineFilter } from './engineFilter'
import { BOARD_KEY, MEMORY_SHELF_KEY, PROJECTOR_KEY, TV_PLAN_KEY } from './engineTypes'
import { BOARD_H, BOARD_W, FACE_Z } from './board/boardLayout'
import { boardPlace } from './furniture'
import { monitorPosition, type ProjectLayout } from './layout'
import type { OfficePower, PowerLevel } from './power'
import type { OfficeScene } from './scene'
import type { ScreenAnchor } from './screenAnchor'
import type { ScoreData } from './tvPaint'

const LEVEL: Readonly<Record<PowerLevel, string>> = { cheia: 'cheia', economia: 'economia', alerta: 'alerta', apagao: 'apagão' }

/** As tarefas do Quadro do projeto (ou de todos), por coluna. */
export function boardCounts(board: Pick<EngineBoard, 'sync'>, projectId: string | null): Pick<ScoreData, 'todo' | 'doing' | 'done'> {
  const out = { todo: 0, doing: 0, done: 0 }
  for (const id of projectId ? [projectId] : board.sync.roomIds) {
    for (const c of board.sync.mirror(id)?.shown ?? []) {
      if (c.status === 'completed') out.done++
      else if (c.status === 'in_progress') out.doing++
      else out.todo++
    }
  }
  return out
}

/**
 * Clique no Agent Manager (à cabeceira): o foco vai para a TV, no plano dele (TV_PLAN_KEY: abre no plano
 * mesmo com agente chamando ou testando). As outras chaves ficam como estão.
 */
export function focusKeyFor(scene: OfficeScene, key: string): string {
  const c = scene.character(key)
  if (c?.spot !== 'manager') return key
  scene.projectors.content.plans.prefer = c.model.convId
  scene.projectors.tick(Date.now())
  return `${TV_PLAN_KEY}${c.model.convId}`
}

/** A câmera de frente para a TV, com a sala em volta (o clique na notificação do chamado); null sem TV. */
export function tvLookPose(scene: OfficeScene, view: ViewSize): CameraPose | null {
  const tv = scene.projectors.screen()
  return tv ? tvPose(tv, view, 0.5) : null
}

/** A tela do console da Central: inclinada para trás; a câmera a olha de frente (perpendicular), então o encaixe em repouso é translação. */
export const CONSOLE_PLANE: ScreenPlane = { halfW: (SCREEN_W * CONSOLE_SCREEN.scale) / 2, halfH: (SCREEN_H * CONSOLE_SCREEN.scale) / 2, front: 0.002, pitch: -CONSOLE_TILT, tilt: CONSOLE_TILT }
export const CONSOLE_AT: MonitorAt = { x: CONSOLE.x, y: CONSOLE_SCREEN.y + 0.019 * Math.sin(-CONSOLE_TILT), z: CONSOLE.z + CONSOLE_SCREEN.z + 0.019 * Math.cos(CONSOLE_TILT) }

/** O kanban da parede: o centro da face (boardPlace + FACE_Z) e o tamanho com folga para a moldura. */
const BOARD_SPOT = boardPlace()
export const BOARD_AT: MonitorAt = { x: BOARD_SPOT.x, y: BOARD_SPOT.y, z: BOARD_SPOT.z + FACE_Z }
export const BOARD_PLANE: ScreenPlane = { halfW: BOARD_W / 2 + 0.25, halfH: BOARD_H / 2 + 0.12, front: 0, pitch: 0 }

/** Pose que enquadra a tela do personagem (o monitor dele ou do pai, o console da Central) ou a TV; a âncora mira a mesma tela. null = o agente saiu. */
export function focusPoseFor(scene: OfficeScene, anchor: ScreenAnchor, key: string, view: ViewSize): CameraPose | null {
  if (key === MEMORY_SHELF_KEY) {
    // A estante de Memórias: um voo curto, com ela à esquerda (o painel abre à direita).
    anchor.aim(null)
    return { tx: MEMORY_SHELF.x - 0.6, ty: 1, tz: MEMORY_SHELF.z + 1.3, yaw: -Math.PI / 2, pitch: 0.3, distance: 4.2 }
  }
  if (key === BOARD_KEY) {
    // O kanban da parede de frente, inteiro no palco (com a moldura, o bloquinho e o cesto em volta).
    anchor.aim(null)
    return screenPose(BOARD_AT, BOARD_PLANE, view)
  }
  const tv = key.startsWith(PROJECTOR_KEY) ? scene.projectors.screen() : null
  if (tv) {
    anchor.aim(tv, TV_PLANE)
    return tvPose(tv, view)
  }
  const c = scene.character(key)
  if (!c) return null
  if (c.spot === 'central') {
    anchor.aim(CONSOLE_AT, CONSOLE_PLANE)
    return screenPose(CONSOLE_AT, CONSOLE_PLANE, view)
  }
  const desk = c.screenDesk ? scene.room(c.screenDesk.roomId)?.desks[c.screenDesk.index] : undefined
  const m = desk ? monitorPosition(desk) : null
  anchor.aim(m)
  if (m) return monitorPose(m, view)
  return { tx: c.x, ty: 1, tz: c.z, yaw: 0, pitch: 0.3, distance: 2.6 }
}

export function wireTv(scene: OfficeScene, board: EngineBoard, filter: EngineFilter, power: () => OfficePower | null, projects: () => readonly ProjectLayout[]): void {
  const content = scene.projectors.content
  content.filter = filter.current
  filter.onChange((id) => {
    content.filter = id
  })
  content.scoreboard = (projectId) => {
    const p = power()
    return {
      project: projectId ? (projects().find((x) => x.id === projectId)?.name ?? null) : null,
      ...boardCounts(board, projectId),
      energy: p ? { pct: p.pct, label: LEVEL[p.level] } : null
    }
  }
}
