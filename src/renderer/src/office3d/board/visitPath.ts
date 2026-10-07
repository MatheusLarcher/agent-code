/**
 * O caminho de verdade da visita do PO (a grade de navegação da sala, desviando
 * das ilhas): de onde ele está até o lado da cadeira do agente e de lá até o
 * quadro. A reta erra muito nas mesas de dentro do U — o caminho dá a volta na
 * ilha, até ~1,9× a reta — e a visita só entra se couber no prazo (LAG_MS).
 *
 * Planeja com um cérebro de rascunho (nunca entra na cena): a mesma conta do
 * Crowd.plan, sem mexer no caminho de ninguém.
 */
import { createBrain, type Brain } from '../brainBody'
import type { RoomFurniture } from '../furniture'

export interface PathPlanner {
  plan(b: Brain): number
  furniture(roomId: string): RoomFurniture | undefined
}

let probe: Brain | null = null

/** Comprimento (m) do caminho de (fx, fz) até (tx, tz) na sala. */
export function pathLength(w: PathPlanner, roomId: string, fx: number, fz: number, tx: number, tz: number): number {
  const b = (probe ??= createBrain({ key: 'probe:visita', role: 'fixed', roomId, home: { x: fx, z: fz, yaw: 0 } }))
  b.roomId = roomId
  b.x = fx
  b.z = fz
  b.goal.x = tx
  b.goal.z = tz
  b.goal.exit = false
  const n = w.plan(b)
  let len = 0
  let px = fx
  let pz = fz
  for (let i = 0; i < n; i++) {
    const x = b.path[i * 2]
    const z = b.path[i * 2 + 1]
    len += Math.hypot(x - px, z - pz)
    px = x
    pz = z
  }
  return len
}

/** Da posição do PO até (x, z) e de lá até o quadro da sala dele (m); null sem sala. */
export function visitPathLength(w: PathPlanner, po: Brain, x: number, z: number): number | null {
  const f = po.roomId ? w.furniture(po.roomId) : undefined
  if (!f || !po.roomId) return null
  return pathLength(w, po.roomId, po.x, po.z, x, z) + pathLength(w, po.roomId, x, z, f.board.x, f.board.pad.z)
}
