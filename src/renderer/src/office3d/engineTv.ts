/**
 * A TV no motor: o filtro de projeto do HUD vale para ela, o placar (a TV
 * ociosa) lê o Quadro real e a energia, e o foco (`focusPoseFor`) voa até a
 * TV de frente (tvPose, sem arfagem) como voa até o monitor. Só liga as pontas
 * — o que a TV mostra é decidido em projectors.ts / tvContent.ts.
 */
import type { EngineBoard } from './board/engineBoard'
import { monitorPose, TV_PLANE, tvPose, type CameraPose, type ViewSize } from './cameraRig'
import type { EngineFilter } from './engineFilter'
import { PROJECTOR_KEY } from './engineTypes'
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

/** A câmera de frente para a TV, com a sala em volta (o clique na notificação do chamado); null sem TV. */
export function tvLookPose(scene: OfficeScene, view: ViewSize): CameraPose | null {
  const tv = scene.projectors.screen()
  return tv ? tvPose(tv, view, 0.5) : null
}

/** Pose que enquadra a tela do personagem (o monitor dele ou do pai) ou a TV; a âncora mira a mesma tela. null = o agente saiu. */
export function focusPoseFor(scene: OfficeScene, anchor: ScreenAnchor, key: string, view: ViewSize): CameraPose | null {
  const tv = key.startsWith(PROJECTOR_KEY) ? scene.projectors.screen() : null
  if (tv) {
    anchor.aim(tv, TV_PLANE)
    return tvPose(tv, view)
  }
  const c = scene.character(key)
  if (!c) return null
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
