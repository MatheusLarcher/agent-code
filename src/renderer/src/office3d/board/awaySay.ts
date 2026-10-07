/**
 * O resumo "desde que você saiu" (awayAnnounce.ts) na voz do PO: ele diz a
 * versão curta quando a cabeça dele está na tela, sem zoom LONGE e com a
 * janela em foco — a câmera chegou na sala ou no quadro. Sem PO à vista, espera.
 */
import { Vector3, type PerspectiveCamera } from 'three'
import { roomIdFor } from '../../office/adapter/model'
import { LOD_BOUNDS } from '../lod'
import type { OfficeScene } from '../scene'
import { awayAnnounce } from './awayAnnounce'
import { clip } from './boardLines'
import type { BoardStage } from './boardStage'

/** O resumo fica no balão do PO por isto (ms). */
export const AWAY_SAY_MS = 9_000

const head = new Vector3()

/** A cabeça do personagem projeta dentro da tela (a mesma regra do balão, speech.ts) e não está LONGE. */
function inView(scene: OfficeScene, camera: PerspectiveCamera, key: string): boolean {
  if (!scene.headWorldPosition(key, head)) return false
  if (head.distanceTo(camera.position) >= LOD_BOUNDS[1]) return false
  const p = head.project(camera)
  return p.z <= 1 && p.z >= -1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1
}

/** Diz os resumos pendentes cujo PO está à vista; `ready` = aba à vista, sem pausa, janela em foco. true se falou. */
export function sayAway(stage: BoardStage, scene: OfficeScene, camera: PerspectiveCamera, ready: boolean): boolean {
  const list = awayAnnounce.pending()
  if (list.length === 0 || !ready) return false
  let changed = false
  for (const a of list) {
    const key = `po:${roomIdFor(a.cwd)}`
    if (!inView(scene, camera, key)) continue
    stage.announce(key, clip(a.text), scene.character(key)?.model.convId ?? '', AWAY_SAY_MS)
    awayAnnounce.markSaid(a)
    changed = true
  }
  return changed
}
