/**
 * Corpo do cérebro de um agente do Escritório 3D — PURO (sem three): os tipos
 * (Brain, BrainWorld, Goal), a criação, a fila de reações e o MOVIMENTO por
 * objetivo — levantar se estiver sentado em outro lugar, andar pelo caminho do
 * A* (velocidade suave, giro pelo menor ângulo), sentar se o objetivo tiver
 * assento e virar para o rumo final. O comportamento (modos, lazer, reações
 * aos eventos) fica em brain.ts, que reexporta tudo daqui.
 */
import type { AgentPhase, ToolKind } from './events'
import { chairSide, seatOf, type Poi, type PoiKind, type Spot } from './furniture'
import { MONITOR_BACK, MONITOR_Y } from './layout'
import { REACTION_S, smooth, type Action, type Reaction, type SeatKind } from './poses'

export type Role = 'desk' | 'visitor' | 'fixed'
export type Mode = 'init' | 'free' | 'work' | 'permission' | 'sleep' | 'queue' | 'leave' | 'away' | 'fixed'
export type Leisure = 'coffee' | 'shelf' | 'window' | 'plant' | 'postit' | 'chat' | 'phone'
export type Gait = 'walk' | 'run' | 'stroll'
export type PropKind = 'cup' | 'book' | 'can' | 'phone' | 'folder' | 'sign' | 'note'
export type Look = 'none' | 'point' | 'camera'
/** Estilo do fixo: o que ele faz parado no lugar. */
export type FixedStyle = 'board' | 'archive' | 'idle'

export const LEISURES: readonly Leisure[] = ['coffee', 'shelf', 'window', 'plant', 'postit', 'chat', 'phone']
export const DWELL_MIN = 6
export const DWELL_MAX = 25
/** Duração de sentar/levantar. */
export const SIT_S = 0.45
export const SPEED: Record<Gait, number> = { walk: 1.15, run: 3, stroll: 0.55 }
const TURN_RATE = 9
const ACCEL = 6
/** Efeitos de uma vez (o animador consome e zera). */
export const FX = { confetti: 1, smoke: 2, sweat: 4, bang: 8, drops: 16 } as const
/** Reações que seguram o passo (as outras acontecem andando). */
const HOLDS: ReadonlySet<Reaction> = new Set<Reaction>(['alert', 'scared', 'knuckles', 'celebrate', 'stretch', 'facepalm', 'fistpump', 'handsHead', 'handoff', 'shrug'])

export interface Goal {
  version: number
  /** Onde ficar em pé (ou de onde sentar). */
  x: number
  z: number
  yaw: number
  seat: SeatKind | null
  sx: number
  sz: number
  syaw: number
  gait: Gait
  /** Sai pela porta (o caminho termina do lado de fora). */
  exit: boolean
}

export interface Brain {
  readonly key: string
  role: Role
  style: FixedStyle
  roomId: string | null
  home: Spot
  /** Mesa própria (senta nela) e o monitor que o representa (olha para ele). */
  desk: { x: number; z: number } | null
  monitor: { x: number; y: number; z: number } | null
  /** Lado do colega para a entrega da pasta (+1 direita, -1 esquerda). */
  side: number
  seed: number
  // ── status (events.ts)
  phase: AgentPhase
  tool: ToolKind | null
  toolAt: number
  contextLow: boolean
  usageOut: boolean
  stalled: boolean
  idleSince: number | null
  // ── corpo
  visible: boolean
  x: number
  z: number
  yaw: number
  speed: number
  sit: number
  seat: SeatKind | null
  seatX: number
  seatZ: number
  standX: number
  standZ: number
  path: Float32Array
  pathLen: number
  pathIdx: number
  planned: number
  atSpot: boolean
  arrived: boolean
  goal: Goal
  // ── comportamento
  mode: Mode
  modeT: number
  leisure: Leisure | null
  leisureT: number
  leisureDur: number
  lastLeisure: Leisure | null
  rest: number
  pause: number
  poi: Poi | null
  chatWith: string | null
  chatLead: boolean
  chatT0: number
  // ── saída para o animador
  action: Action
  actionT: number
  reaction: Reaction | null
  reactionT: number
  pending: Reaction[]
  prop: PropKind | null
  look: Look
  lookX: number
  lookY: number
  lookZ: number
  faceCamera: boolean
  fx: number
  zzz: boolean
  rush: boolean
  knuckles: boolean
  nextYawn: number
  nextWatch: number
  workSpeed: number
}

/** O que o cérebro pede ao mundo (a sala, a reserva e os colegas). */
export interface BrainWorld {
  /** Relógio (s). */
  t: number
  rng(): number
  /** Cochila depois de tantos segundos parado. */
  sleepAfter: number
  camX: number
  camZ: number
  /** Caminho de (b.x, b.z) até b.goal em b.path; devolve quantos pontos (sempre ≥ 1). */
  plan(b: Brain): number
  /** Reserva um ponto livre do tipo; null se todos ocupados. */
  claim(b: Brain, kind: PoiKind): Poi | null
  /** Solta tudo o que o agente reservou. */
  release(b: Brain): void
  /** Melhor lugar livre na fila do café (o mais à frente); mantém o atual se não houver melhor. */
  queueSpot(b: Brain): Poi | null
  /** Ponto livre sorteado na sala (celular andando). */
  wander(b: Brain, out: { x: number; z: number }): boolean
  /** Forma par de conversa com outro ocioso da sala (configura os dois). */
  pairUp(b: Brain): boolean
  /** O par da conversa, se ainda estiver nela. */
  partner(b: Brain): Brain | null
  /** Do lado de fora da porta da sala. */
  doorOut(b: Brain): Spot | null
}

export interface BrainInit {
  key: string
  role: Role
  style?: FixedStyle
  roomId: string | null
  home: Spot
  desk?: { x: number; z: number } | null
  monitor?: { x: number; y: number; z: number } | null
  side?: number
  seed?: number
  /** Começa fora da sala (entra pela porta). */
  away?: boolean
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01

export function createBrain(o: BrainInit): Brain {
  const desk = o.desk ?? null
  const b: Brain = {
    key: o.key, role: o.role, style: o.style ?? 'idle', roomId: o.roomId, home: { ...o.home }, desk,
    monitor: o.monitor ?? (desk ? { x: desk.x, y: MONITOR_Y, z: desk.z - MONITOR_BACK } : null),
    side: o.side ?? 1, seed: o.seed ?? 0,
    phase: 'idle', tool: null, toolAt: 0, contextLow: false, usageOut: false, stalled: false, idleSince: null,
    visible: !o.away, x: o.home.x, z: o.home.z, yaw: o.home.yaw, speed: 0, sit: 0, seat: null, seatX: 0, seatZ: 0, standX: o.home.x, standZ: o.home.z,
    path: new Float32Array(64), pathLen: 0, pathIdx: 0, planned: -1, atSpot: true, arrived: true,
    goal: { version: 0, x: o.home.x, z: o.home.z, yaw: o.home.yaw, seat: null, sx: 0, sz: 0, syaw: 0, gait: 'walk', exit: false },
    mode: 'init', modeT: 0, leisure: null, leisureT: 0, leisureDur: 0, lastLeisure: null, rest: 0, pause: -1, poi: null,
    chatWith: null, chatLead: false, chatT0: -1,
    action: 'idle', actionT: 0, reaction: null, reactionT: 0, pending: [], prop: null, look: 'none', lookX: 0, lookY: 0, lookZ: 0,
    faceCamera: false, fx: 0, zzz: false, rush: false, knuckles: false, nextYawn: 0, nextWatch: 0, workSpeed: 1
  }
  // Quem tem mesa e está na sala começa sentado nela.
  if (desk && !o.away && o.role !== 'fixed') {
    const s = seatOf(desk)
    const side = chairSide(desk, 1)
    Object.assign(b, { x: s.x, z: s.z, yaw: s.yaw, sit: 1, seat: 'chair', seatX: s.x, seatZ: s.z, standX: side.x, standZ: side.z })
    Object.assign(b.goal, { x: side.x, z: side.z, yaw: s.yaw, seat: 'chair', sx: s.x, sz: s.z, syaw: s.yaw })
  }
  return b
}

// ── reações (fila de até 3; a atual segura ou não o passo, ver HOLDS) ──────

export function pushReaction(b: Brain, r: Reaction): void {
  if (b.reaction === r || b.pending.includes(r) || b.pending.length >= 3) return
  if (b.reaction === null) startReaction(b, r)
  else b.pending.push(r)
}

function startReaction(b: Brain, r: Reaction): void {
  b.reaction = r
  b.reactionT = 0
  if (r === 'celebrate' || r === 'stretch') b.fx |= FX.confetti
  else if (r === 'facepalm') b.fx |= FX.smoke | FX.sweat
  else if (r === 'alert' || r === 'scared') b.fx |= FX.bang
}

// ── objetivo e movimento ───────────────────────────────────────────────────

export function goStand(b: Brain, x: number, z: number, yaw: number, gait: Gait, exit = false): void {
  const g = b.goal
  g.yaw = yaw
  g.gait = gait
  if (g.seat === null && near(g.x, x) && near(g.z, z) && g.exit === exit) return
  g.version++
  g.x = x
  g.z = z
  g.seat = null
  g.exit = exit
  b.atSpot = false
  b.arrived = false
}

export function goSeat(b: Brain, seat: SeatKind, sx: number, sz: number, syaw: number, standX: number, standZ: number, gait: Gait): void {
  const g = b.goal
  g.gait = gait
  if (g.seat === seat && near(g.sx, sx) && near(g.sz, sz)) return
  g.version++
  Object.assign(g, { seat, sx, sz, syaw, x: standX, z: standZ, yaw: syaw, exit: false })
  b.arrived = false
  b.atSpot = b.sit > 0 && b.seat === seat && near(b.seatX, sx) && near(b.seatZ, sz)
}

/** Fica onde está (sentado continua sentado; em pé, nem replaneja). */
export function stay(b: Brain): void {
  if (b.sit > 0 && b.seat) return goSeat(b, b.seat, b.seatX, b.seatZ, b.goal.syaw, b.standX, b.standZ, 'walk')
  const g = b.goal
  g.version++
  g.x = b.x
  g.z = b.z
  g.yaw = b.yaw
  g.seat = null
  g.exit = false
  g.gait = 'walk'
  b.planned = g.version
  b.pathLen = 0
  b.atSpot = true
}

export function goDesk(b: Brain, gait: Gait): void {
  if (!b.desk) return goStand(b, b.home.x, b.home.z, b.home.yaw, gait)
  const s = seatOf(b.desk)
  const side = chairSide(b.desk, b.x >= b.desk.x ? 1 : -1)
  goSeat(b, 'chair', s.x, s.z, s.yaw, side.x, side.z, gait)
}

export function turnToward(from: number, to: number, max: number): number {
  let d = (to - from) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return from + Math.max(-max, Math.min(max, d))
}

function follow(b: Brain, dt: number): void {
  if (b.pathIdx >= b.pathLen) {
    b.atSpot = true
    return
  }
  const tx = b.path[b.pathIdx * 2]
  const tz = b.path[b.pathIdx * 2 + 1]
  const dx = tx - b.x
  const dz = tz - b.z
  const dist = Math.hypot(dx, dz)
  const last = b.pathIdx === b.pathLen - 1
  if (dist < (last ? 0.03 : 0.15)) {
    b.pathIdx++
    if (b.pathIdx >= b.pathLen) {
      b.atSpot = true
      b.speed = 0
    }
    return
  }
  const want = Math.atan2(-dx, -dz)
  const off = Math.abs(turnToward(b.yaw, want, Math.PI) - b.yaw)
  b.yaw = turnToward(b.yaw, want, TURN_RATE * dt)
  let target = SPEED[b.goal.gait] * Math.max(0.15, Math.cos(Math.min(off, 1.5)))
  if (last) target = Math.min(target, 0.3 + 2.2 * dist)
  b.speed += Math.max(-ACCEL * dt, Math.min(ACCEL * dt, target - b.speed))
  const step = Math.min(dist, Math.max(0, b.speed) * dt)
  b.x += (dx / dist) * step
  b.z += (dz / dist) * step
}

export function move(b: Brain, dt: number, w: BrainWorld): void {
  const g = b.goal
  const keepSeat = g.seat !== null && g.seat === b.seat && near(g.sx, b.seatX) && near(g.sz, b.seatZ)
  // 1) Sentado em outro lugar: levanta (volta para o lado do assento).
  if (b.sit > 0 && !keepSeat) {
    b.arrived = false
    b.speed = 0
    b.sit = Math.max(0, b.sit - dt / SIT_S)
    const k = smooth(b.sit)
    b.x = b.standX + (b.seatX - b.standX) * k
    b.z = b.standZ + (b.seatZ - b.standZ) * k
    if (b.sit === 0) {
      b.seat = null
      b.planned = -1
      b.atSpot = false
    }
    return
  }
  // 2) Anda até o ponto em pé do objetivo.
  if (b.sit === 0 && !b.atSpot) {
    b.arrived = false
    if (b.reaction && HOLDS.has(b.reaction)) {
      b.speed = 0
      return
    }
    if (b.planned !== g.version) {
      b.pathLen = w.plan(b)
      b.pathIdx = 0
      b.planned = g.version
    }
    follow(b, dt)
    return
  }
  // 3) Senta, se o objetivo tem assento.
  if (g.seat !== null && b.sit < 1) {
    if (b.sit === 0) Object.assign(b, { seat: g.seat, seatX: g.sx, seatZ: g.sz, standX: b.x, standZ: b.z })
    b.speed = 0
    b.sit = Math.min(1, b.sit + dt / SIT_S)
    const k = smooth(b.sit)
    b.x = b.standX + (b.seatX - b.standX) * k
    b.z = b.standZ + (b.seatZ - b.standZ) * k
    b.yaw = turnToward(b.yaw, g.syaw, 7 * dt)
    b.arrived = b.sit >= 1
    return
  }
  // 4) Chegou: vira para o rumo final (ou para a câmera).
  b.speed = 0
  const want = b.faceCamera ? Math.atan2(-(w.camX - b.x), -(w.camZ - b.z)) : g.seat ? g.syaw : g.yaw
  b.yaw = turnToward(b.yaw, want, TURN_RATE * 0.6 * dt)
  b.arrived = true
}

export function setAction(b: Brain, a: Action): void {
  if (b.action === a) return
  b.action = a
  b.actionT = 0
}

export function lookAt(b: Brain, x: number, y: number, z: number): void {
  b.look = 'point'
  b.lookX = x
  b.lookY = y
  b.lookZ = z
}

export function endLeisure(b: Brain, w: BrainWorld, rest: number): void {
  w.release(b)
  Object.assign(b, { poi: null, leisure: null, chatWith: null, chatT0: -1, prop: null, rest, leisureT: 0, pause: -1, look: 'none' })
}

/** A sala andou (outra fileira de mesas mudou a grade): leva o agente junto e replaneja. */
export function relocate(b: Brain, dx: number, dz: number): void {
  b.x += dx
  b.z += dz
  b.seatX += dx
  b.seatZ += dz
  b.standX += dx
  b.standZ += dz
  const g = b.goal
  g.x += dx
  g.z += dz
  g.sx += dx
  g.sz += dz
  g.version++
  b.planned = -1
  if (b.sit === 0) b.atSpot = false
  // Os POIs da sala foram refeitos: o lazer em curso recomeça do zero.
  if (b.leisure !== null) Object.assign(b, { leisure: null, poi: null, chatWith: null, chatT0: -1, prop: null, rest: 0.5 })
  else b.poi = null
}

/** Avança a reação atual; acabou, começa a próxima da fila. */
export function tickReaction(b: Brain, dt: number): void {
  if (!b.reaction) return
  b.reactionT += dt
  if (b.reactionT < REACTION_S[b.reaction]) return
  b.reaction = null
  const next = b.pending.shift()
  if (next) startReaction(b, next)
}

/** Precisa de quadros? Parado dormindo (ou fora) não; o resto sim. */
export function brainBusy(b: Brain): boolean {
  if (!b.visible) return false
  if (b.reaction || b.speed > 0 || (b.sit > 0 && b.sit < 1) || !b.arrived) return true
  return b.mode !== 'sleep' && !(b.mode === 'fixed' && b.phase !== 'working')
}
