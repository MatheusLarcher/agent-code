/**
 * Quem fica onde na sala de reunião — PURO. A TV é a única tela do escritório:
 * quem a está usando (o chamado do agente, app_chamar_usuario; o teste ao vivo
 * no navegador/Android) fica DE PÉ ao lado dela, e quem espera a vez senta à
 * mesa: as cadeiras das pontas, depois as do fundo (as da frente ficam entre a
 * mesa e o vidro, sem passagem para levantar).
 *
 *   managerSeat(i)      a cadeira i dos Agent Managers (planejamento): as
 *                       cabeceiras, depois as do fundo de fora para dentro;
 *   managerChairs(ks, prev)  a cadeira de cada Manager: quem já tinha fica com
 *                       ela; quem chega pega a 1ª livre (um sair não troca os outros);
 *   meetingSpots(fila, ocupadas, antes)  fila[0] fica ao lado da TV, o resto espera sentado
 *                       fora das cadeiras ocupadas pelos Managers (quem já estava numa
 *                       cadeira livre fica nela; os outros, na ordem da fila); quem não
 *                       cabe fica de fora. `call` marca quem chamou o usuário (acena
 *                       para a câmera em vez de olhar a TV);
 *   MeetingVenues       a fila e as cadeiras dos Managers juntas: a sala é refeita
 *                       quando qualquer uma muda (uma cadeira, um agente).
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

/** A cadeira i dos Managers e o ponto de levantar dela; null sem cadeira. */
export function managerSeat(i: number): (Spot & { standX: number; standZ: number }) | null {
  const c = MANAGER_CHAIRS[i]
  if (!c) return null
  const st = standOf(c)
  return { ...c, standX: st.x, standZ: st.z }
}

/** A cadeira (o `i` de managerSeat) de cada Manager em cena: quem já tinha (`prev`) fica com ela; quem chega pega a 1ª livre; sem livre, fica sem. */
export function managerChairs(keys: readonly string[], prev: Readonly<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {}
  const taken = new Set<number>()
  for (const k of keys) {
    const i = prev[k]
    if (i === undefined || taken.has(i)) continue
    out[k] = i
    taken.add(i)
  }
  for (const k of keys) {
    if (out[k] !== undefined) continue
    const i = MANAGER_CHAIRS.findIndex((_, j) => !taken.has(j))
    if (i < 0) break
    out[k] = i
    taken.add(i)
  }
  return out
}

const near = (a: { x: number; z: number }, b: { x: number; z: number }): boolean => Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.z - b.z) < 1e-3

/**
 * A sala para a fila `order`: fila[0] ao lado da TV e quem espera nas cadeiras sem Manager (`held`). Com `prev` (a sala
 * de antes), quem já esperava sentado numa cadeira que continua livre fica nela — Manager que chega ou sai não faz a
 * fila inteira levantar; os outros pegam as livres na ordem.
 */
export function meetingSpots(order: readonly MeetingEntry[], held: ReadonlyArray<{ x: number; z: number }> = [], prev?: ReadonlyMap<string, MeetingSpot>): Map<string, MeetingSpot> {
  const out = new Map<string, MeetingSpot>()
  // As cadeiras ocupadas pelos Managers ficam com eles.
  const chairs = WAIT_CHAIRS.filter((c) => !held.some((h) => near(h, c)))
  const waiting: Array<{ key: string; call: boolean }> = []
  for (const e of order) {
    const key = typeof e === 'string' ? e : e.key
    const call = typeof e !== 'string' && e.call
    if (out.has(key) || waiting.some((w) => w.key === key)) continue
    if (out.size === 0) out.set(key, { role: 'present', x: TV_SIDE.x, z: TV_SIDE.z, yaw: LOOK_TV, seat: false, standX: TV_SIDE.x, standZ: TV_SIDE.z, call })
    else waiting.push({ key, call })
  }
  const taken = new Set<Spot>()
  const sit = (w: { key: string; call: boolean }, c: Spot): void => {
    taken.add(c)
    const st = standOf(c)
    out.set(w.key, { role: 'wait', x: c.x, z: c.z, yaw: c.yaw, seat: true, standX: st.x, standZ: st.z, call: w.call })
  }
  const rest = waiting.filter((w) => {
    const p = prev?.get(w.key)
    const c = p?.seat ? chairs.find((f) => !taken.has(f) && near(f, p)) : undefined
    if (c) sit(w, c)
    return !c
  })
  for (const w of rest) {
    const c = chairs.find((f) => !taken.has(f))
    if (!c) break
    sit(w, c)
  }
  return out
}

/**
 * A fila da TV e as cadeiras dos Agent Managers juntas: quem espera a vez só senta
 * numa cadeira sem Manager. A cena avisa quando a fila muda (`setQueue`, o onRoom
 * da TV) e a cada layout (`setChairs`): Manager que chega numa cadeira onde alguém
 * esperava manda quem espera para a próxima livre. `apply` = crowd.setVenues (quem
 * continua no mesmo lugar não se mexe).
 */
export class MeetingVenues {
  private order: readonly MeetingEntry[] = []
  private held: ReadonlyArray<{ x: number; z: number }> = []
  /** A sala da última vez: quem espera continua na cadeira dele enquanto ela estiver livre. */
  private last = new Map<string, MeetingSpot>()
  constructor(private readonly apply: (spots: Map<string, MeetingSpot>) => void) {}

  setQueue(order: readonly MeetingEntry[]): void {
    this.order = order
    this.refresh()
  }

  /** Os personagens do layout: as cadeiras dos Managers são os lugares deles (spot 'manager'). */
  setChairs(chars: ReadonlyArray<{ spot: string; x: number; z: number }>): void {
    this.held = chars.filter((c) => c.spot === 'manager')
    this.refresh()
  }

  private refresh(): void {
    this.last = meetingSpots(this.order, this.held, this.last)
    this.apply(this.last)
  }
}

/** O mesmo lugar (a sala refez a fila, mas esta pessoa continua onde estava). */
export function sameSpot(a: MeetingSpot | null, b: MeetingSpot | null): boolean {
  return a === b || (!!a && !!b && a.role === b.role && a.call === b.call && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6)
}
