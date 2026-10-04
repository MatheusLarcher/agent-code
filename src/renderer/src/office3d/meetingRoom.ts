/**
 * Quem fica onde na sala de reunião — PURO. A TV é a única tela do escritório:
 * quem a está usando (o chamado do agente, app_chamar_usuario; o teste ao vivo
 * no navegador/Android) fica DE PÉ ao lado dela, e quem espera a vez senta à
 * mesa: as cadeiras das pontas, depois as do fundo (as da frente ficam entre a
 * mesa e o vidro, sem passagem para levantar).
 *
 *   managerSeat(i)      a cadeira do i-ésimo Agent Manager (planejamento): as
 *                       cabeceiras, depois as do fundo de fora para dentro;
 *   meetingSpots(fila, managers)  fila[0] fica ao lado da TV, o resto espera sentado na
 *                       ordem da fila; quem não cabe fica de fora. `call` marca
 *                       quem chamou o usuário (acena para a câmera em vez de
 *                       olhar a TV).
 */
import { meetingChairs, type Spot } from './furniture'
import { BACK_FACE_Z, MEETING } from './officePlan'

export type MeetingRole = 'present' | 'wait'

/** O lugar na sala: de pé (x, z, yaw) ou sentado numa cadeira (o assento e o ponto de levantar). */
export interface MeetingSpot {
  role: MeetingRole
  x: number
  z: number
  yaw: number
  seat: boolean
  standX: number
  standZ: number
  /** Chamou o usuário (app_chamar_usuario): acena; ao lado da TV, pula depois de CALL_JUMP_S. */
  call: boolean
}

/** Um da fila da sala: a chave do personagem e se é chamado (sem: teste ao vivo). */
export type MeetingEntry = string | { key: string; call: boolean }

/** De pé, à direita da TV, um passo à frente da parede. */
export const TV_SIDE = { x: MEETING.tv.x + MEETING.tv.w / 2 + 0.55, z: BACK_FACE_Z + 0.62 } as const
/** O centro da tela da TV (para onde quem testa olha). */
export const TV_CENTER = { x: MEETING.tv.x, y: MEETING.tv.y, z: BACK_FACE_Z + 0.12 } as const

/** As cadeiras na ordem de quem espera: as das pontas e as do fundo (do meio para fora). */
const WAIT_CHAIRS: readonly Spot[] = (() => {
  const all = meetingChairs()
  const sides = all.filter((c) => Math.abs(c.x - MEETING.table.x) > MEETING.table.w / 2)
  const back = all.filter((c) => c.z < MEETING.table.z && Math.abs(c.x - MEETING.table.x) < MEETING.table.w / 2)
  const byCenter = (a: Spot, b: Spot): number => Math.abs(a.x - MEETING.table.x) - Math.abs(b.x - MEETING.table.x)
  return [...sides, ...back.sort(byCenter)]
})()

/** As cadeiras dos Agent Managers: as cabeceiras e, depois, as do fundo de fora para dentro. */
const MANAGER_CHAIRS: readonly Spot[] = (() => {
  const all = meetingChairs()
  const sides = all.filter((c) => Math.abs(c.x - MEETING.table.x) > MEETING.table.w / 2)
  const back = all.filter((c) => c.z < MEETING.table.z && Math.abs(c.x - MEETING.table.x) < MEETING.table.w / 2)
  return [...sides, ...back.sort((a, b) => Math.abs(b.x - MEETING.table.x) - Math.abs(a.x - MEETING.table.x))]
})()

/** Para onde olha quem está ao lado da TV: para a tela (0 = −Z). */
const LOOK_TV = Math.atan2(-(TV_CENTER.x - TV_SIDE.x), -(TV_CENTER.z - TV_SIDE.z))

/** O ponto de levantar de uma cadeira da sala: 0,7 m atrás dela, já no corredor livre (o rumo yaw olha para a mesa; 0 = −Z). */
function standOf(c: Spot): { x: number; z: number } {
  return { x: c.x + Math.sin(c.yaw) * 0.7, z: c.z + Math.cos(c.yaw) * 0.7 }
}

/** O ponto de levantar de uma cadeira da sala (o Agent Manager sentado à cabeceira). */
export const chairStand = (c: Spot): { x: number; z: number } => standOf(c)

/** A cadeira do i-ésimo Manager e o ponto de levantar dela; null sem cadeira. */
export function managerSeat(i: number): (Spot & { standX: number; standZ: number }) | null {
  const c = MANAGER_CHAIRS[i]
  if (!c) return null
  const st = standOf(c)
  return { ...c, standX: st.x, standZ: st.z }
}

export function meetingSpots(order: readonly MeetingEntry[], managers = 0): Map<string, MeetingSpot> {
  const out = new Map<string, MeetingSpot>()
  // As cadeiras dos Managers ficam com eles.
  const held = MANAGER_CHAIRS.slice(0, managers)
  const chairs = WAIT_CHAIRS.filter((c) => !held.some((h) => Math.abs(h.x - c.x) < 1e-6 && Math.abs(h.z - c.z) < 1e-6))
  let i = 0
  for (const e of order) {
    const key = typeof e === 'string' ? e : e.key
    const call = typeof e !== 'string' && e.call
    if (out.has(key)) continue
    if (i === 0) out.set(key, { role: 'present', x: TV_SIDE.x, z: TV_SIDE.z, yaw: LOOK_TV, seat: false, standX: TV_SIDE.x, standZ: TV_SIDE.z, call })
    else {
      const c = chairs[i - 1]
      if (!c) break
      const st = standOf(c)
      out.set(key, { role: 'wait', x: c.x, z: c.z, yaw: c.yaw, seat: true, standX: st.x, standZ: st.z, call })
    }
    i++
  }
  return out
}

/** O mesmo lugar (a sala refez a fila, mas esta pessoa continua onde estava). */
export function sameSpot(a: MeetingSpot | null, b: MeetingSpot | null): boolean {
  return a === b || (!!a && !!b && a.role === b.role && a.call === b.call && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6)
}
