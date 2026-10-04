/**
 * Cérebro de um agente do Escritório 3D — FSM PURA: sem three, sem relógio
 * próprio e com o sorteio injetado (BrainWorld.rng), então o mesmo mundo e os
 * mesmos passos dão o mesmo comportamento.
 *
 * A FASE do AgentStatus (events.ts) manda no modo; os EVENTOS só disparam
 * reações curtas por cima. Modos:
 *   free        sem tarefa: alterna lazeres (café, estante, janela, regar a
 *               planta, ler o quadro, conversar com outro ocioso, celular andando),
 *               cada um de DWELL_MIN a DWELL_MAX s, com uma pausa entre eles;
 *   sleep       parado há sleepAfter s: cochila no sofá/poltrona do lounge (se livre) ou na mesa;
 *   work        senta na própria mesa; o gesto segue a ferramenta atual;
 *   permission  levanta ao lado da cadeira, vira para a câmera e acena;
 *   queue       limite de uso: fila na máquina de café até voltar;
 *   leave/away  visitante (especialista/subagente) sai pela porta / fora;
 *   fixed       PO, memorista e vigia: ficam no lugar deles;
 *   party       apagão (sem tokens): todo mundo com papel na festa — dança,
 *               trenzinho, lanterna, pizza (brainParty.ts) — por cima de tudo;
 *   back        a luz voltou: corre para a própria mesa e senta por BACK_S
 *               (quem tem tarefa já volta direto ao 'work').
 * O movimento (objetivo → levantar, andar, sentar, virar) e os tipos ficam em
 * brainBody.ts, reexportado daqui. Reações "de corpo" seguram o passo
 * enquanto duram.
 */
import {
  DWELL_MAX,
  DWELL_MIN,
  endLeisure,
  goDesk,
  goSeat,
  goStand,
  LEISURES,
  lookAt,
  move,
  pushReaction,
  seatAtDesk,
  setAction,
  stay,
  tickReaction,
  FX,
  type Brain,
  type BrainWorld,
  type Gait,
  type Leisure,
  type Mode
} from './brainBody'
import { runErrand, type BoardWorld } from './brainBoard'
import { enterParty, runParty } from './brainParty'
import { CONTEXT_LOW_STEPS, STALL_MS, type AgentEventBody, type AgentPhase, type AgentStatus, type ToolKind } from './events'
import { chairSide, type Poi } from './furniture'

export * from './brainBody'

// ── status e eventos ───────────────────────────────────────────────────────

export interface BrainStatus {
  phase: AgentPhase
  tool: ToolKind | null
  contextPct: number | null
  usageOut: boolean
  stalled: boolean
  /** Desde quando está parado, no relógio do cérebro (s); null ocupado/sem dado. */
  idleSince: number | null
}

/** AgentStatus → BrainStatus, convertendo o epoch (wallNow) para o relógio `t`. */
export function brainStatus(s: AgentStatus, t: number, wallNow: number): BrainStatus {
  return {
    phase: s.phase,
    tool: s.tool?.kind ?? null,
    contextPct: s.contextPct,
    usageOut: s.usageExhausted !== null,
    stalled: s.stalledMs >= STALL_MS,
    idleSince: s.idleSinceMs === null ? null : t - Math.max(0, wallNow - s.idleSinceMs) / 1000
  }
}

export function setStatus(b: Brain, s: BrainStatus, t: number): void {
  b.phase = s.phase
  if (s.tool !== b.tool) {
    b.tool = s.tool
    b.toolAt = t
  }
  const low = s.contextPct !== null && s.contextPct <= CONTEXT_LOW_STEPS[0]
  if (low && !b.contextLow) b.nextYawn = t + 6
  b.contextLow = low
  b.usageOut = s.usageOut
  if (s.stalled && !b.stalled) b.nextWatch = t + 5
  b.stalled = s.stalled
  b.idleSince = s.idleSince
}

/** Reação a um evento de events.ts (só as one-shot; a fase muda o modo no passo). */
export function react(b: Brain, e: AgentEventBody, w: Pick<BrainWorld, 't' | 'rng'>): void {
  switch (e.type) {
    case 'request':
      if (b.mode === 'sleep' || b.zzz) pushReaction(b, 'scared')
      pushReaction(b, 'alert')
      b.rush = true
      b.knuckles = true
      return
    case 'tool':
      b.toolAt = w.t
      if (e.kind === 'task') pushReaction(b, 'handoff')
      return
    case 'test-result':
      pushReaction(b, e.failed > 0 ? 'handsHead' : 'fistpump')
      return
    case 'error':
      pushReaction(b, 'facepalm')
      return
    case 'done':
      pushReaction(b, w.rng() < 0.5 ? 'celebrate' : 'stretch')
      return
    case 'context-low':
      pushReaction(b, 'yawn')
      b.nextYawn = w.t + 9 + w.rng() * 6
      return
    case 'stalled':
      pushReaction(b, 'watch')
      b.nextWatch = w.t + 5 + w.rng() * 3
      return
    case 'usage-back':
      pushReaction(b, 'alert')
      b.rush = true
      return
    case 'return':
      pushReaction(b, e.ok ? 'thumbsUp' : 'shrug')
      return
    default:
      return
  }
}

/**
 * Filtro de projeto com o agente fora da tela (ou o motor pausado): vai direto
 * ao fim, sem andar — filtrado fora já está lá fora; de volta, já sentado na
 * mesa (sem mesa, no lugar dele) e o próximo passo decide o modo.
 */
export function snapFilter(b: Brain, w: BrainWorld): void {
  if (b.outside) {
    if (b.mode !== 'away') enterMode(b, 'away', w)
    return
  }
  if (b.visible) return
  endLeisure(b, w, 0)
  Object.assign(b, { visible: true, mode: 'init', x: b.home.x, z: b.home.z, yaw: b.home.yaw, speed: 0, sit: 0, seat: null, pathLen: 0, atSpot: true, arrived: true })
  if (b.desk) seatAtDesk(b, b.desk)
}

/** Clique no agente: olha para a câmera e dá um tchauzinho. */
export function greet(b: Brain): void {
  pushReaction(b, 'greet')
}

// ── modos ──────────────────────────────────────────────────────────────────

function decide(b: Brain, w: BrainWorld): Mode {
  // Filtrado fora: sai pela porta e espera lá fora (a mesa continua dele).
  if (b.outside) return b.visible ? 'leave' : 'away'
  if (b.party !== null) return 'party'
  const busy = b.phase === 'working' || b.phase === 'waiting-permission'
  if (b.role === 'fixed') return 'fixed'
  if (b.role === 'visitor') {
    if (busy) return b.phase === 'waiting-permission' && b.desk ? 'permission' : 'work'
    return b.visible ? 'leave' : 'away'
  }
  if (b.usageOut) return 'queue'
  if (busy) return b.phase === 'waiting-permission' ? 'permission' : 'work'
  if (w.t < b.backUntil && b.desk) return 'back'
  if (b.mode === 'sleep' || (b.idleSince !== null && w.t - b.idleSince >= w.sleepAfter)) return 'sleep'
  return 'free'
}

function enterMode(b: Brain, m: Mode, w: BrainWorld): void {
  b.mode = m
  b.modeT = 0
  endLeisure(b, w, 0)
  b.zzz = false
  b.faceCamera = false
  const gait: Gait = b.rush ? 'run' : 'walk'
  // Volta de fora (visitante chamado, filtro de projeto desfeito): entra pela porta.
  const entering = !b.visible && m !== 'away' && m !== 'leave'
  if (entering) {
    const d = w.doorOut(b) ?? b.home
    Object.assign(b, { visible: true, x: d.x, z: d.z, yaw: d.yaw, sit: 0, seat: null, atSpot: false })
  }
  switch (m) {
    case 'party':
    case 'work':
    case 'permission':
      if (m === 'party') enterParty(b, w)
      else if (m === 'work') goDesk(b, gait)
      else if (b.desk && b.sit > 0) goStand(b, b.standX, b.standZ, Math.PI, gait)
      else if (b.desk) {
        const side = chairSide(b.desk)
        goStand(b, side.x, side.z, Math.PI, gait)
      } else goStand(b, b.home.x, b.home.z, Math.PI, gait)
      return
    case 'sleep': {
      const p = w.claim(b, 'sofa')
      if (p) {
        b.poi = p
        goSeat(b, 'sofa', p.look.x, p.look.z, p.yaw, p.x, p.z, 'walk')
      } else if (b.desk) goDesk(b, 'walk')
      else stay(b)
      return
    }
    case 'queue':
      b.nextWatch = w.t + 4 + w.rng() * 4
      queueUp(b, w)
      return
    case 'back':
      goDesk(b, 'run')
      return
    case 'free':
      b.rest = 2 + w.rng() * 4
      // Quem voltou pela porta vai primeiro para a mesa dele.
      if (entering) goDesk(b, 'walk')
      else stay(b)
      return
    case 'leave': {
      const d = w.doorOut(b)
      if (d) goStand(b, d.x, d.z, d.yaw, 'walk', true)
      else b.visible = false
      return
    }
    case 'away':
      Object.assign(b, { visible: false, sit: 0, seat: null })
      return
    case 'fixed':
      goStand(b, b.home.x, b.home.z, b.home.yaw, 'walk')
      return
  }
}

function queueUp(b: Brain, w: BrainWorld): void {
  const spot = w.queueSpot(b)
  if (!spot) return stay(b)
  if (spot !== b.poi) {
    b.poi = spot
    b.leisureT = 0
  }
  goStand(b, spot.x, spot.z, spot.yaw, b.rush ? 'run' : 'walk')
}

function runWork(b: Brain, w: BrainWorld): void {
  if (!b.arrived) {
    if (b.rush) b.goal.gait = 'run'
    setAction(b, 'none')
    b.look = 'none'
    return
  }
  b.rush = false
  if (b.knuckles) {
    b.knuckles = false
    pushReaction(b, 'knuckles')
  }
  if (b.monitor) lookAt(b, b.monitor.x, b.monitor.y, b.monitor.z)
  b.workSpeed = b.contextLow ? 0.55 : 1
  if (!b.desk) setAction(b, 'assist')
  else if (b.stalled) setAction(b, 'drum')
  else if (b.tool === 'edit' || b.tool === 'write') setAction(b, 'typeFast')
  else if (b.tool === 'read' || b.tool === 'search') setAction(b, 'readScreen')
  else if (b.tool === 'bash') setAction(b, w.t - b.toolAt < 1.4 ? 'type' : 'drum')
  else if (b.tool === 'web') setAction(b, 'web')
  else setAction(b, 'type')
  if (b.contextLow && w.t >= b.nextYawn) {
    pushReaction(b, 'yawn')
    b.nextYawn = w.t + 9 + w.rng() * 9
  }
  if (b.stalled && w.t >= b.nextWatch) {
    pushReaction(b, 'watch')
    b.nextWatch = w.t + 5 + w.rng() * 4
  }
}

function runQueue(b: Brain, dt: number, w: BrainWorld): void {
  // A cada ~0,6 s, anda para a frente se abriu lugar.
  if (Math.floor(b.modeT / 0.6) !== Math.floor((b.modeT - dt) / 0.6)) queueUp(b, w)
  if (!b.arrived) {
    setAction(b, 'none')
    b.prop = null
    b.look = 'none'
    return
  }
  if (b.poi) lookAt(b, b.poi.look.x, b.poi.look.y, b.poi.look.z)
  if (b.poi?.kind === 'coffee') {
    b.leisureT += dt
    setAction(b, b.leisureT < 2.4 ? 'brew' : 'sip')
    b.prop = b.leisureT < 2.4 ? null : 'cup'
    return
  }
  setAction(b, 'wait')
  b.prop = null
  if (w.t >= b.nextWatch) {
    pushReaction(b, 'watch')
    b.nextWatch = w.t + 6 + w.rng() * 5
  }
}

function runFixed(b: Brain): void {
  b.look = 'none'
  const working = b.phase === 'working'
  if (working && b.style === 'board') setAction(b, 'readBoard')
  else if (working && b.style === 'archive') setAction(b, 'readBook')
  else if (b.style === 'console') setAction(b, b.arrived ? (working ? 'type' : 'readScreen') : 'none')
  else setAction(b, b.arrived ? 'idle' : 'none')
  b.prop = working && b.style === 'archive' ? 'book' : null
}

function runMode(b: Brain, dt: number, w: BrainWorld): void {
  switch (b.mode) {
    case 'work':
      return runWork(b, w)
    case 'permission':
      if (b.arrived) {
        setAction(b, 'wave')
        b.prop = 'sign'
        b.faceCamera = true
        b.look = 'camera'
      } else {
        setAction(b, 'none')
        if (b.rush) b.goal.gait = 'run'
      }
      return
    case 'sleep':
      if (b.arrived) {
        setAction(b, b.seat === 'sofa' ? 'napSofa' : b.seat === 'chair' ? 'napDesk' : 'idle')
        b.zzz = b.seat !== null
        b.look = 'none'
      } else setAction(b, 'none')
      return
    case 'queue':
      return runQueue(b, dt, w)
    case 'free':
      return runFree(b, dt, w)
    case 'leave':
      setAction(b, 'none')
      if (b.arrived) Object.assign(b, { visible: false, speed: 0 })
      return
    case 'fixed':
      return runFixed(b)
    case 'party':
      return runParty(b, dt, w)
    case 'back':
      setAction(b, b.arrived ? 'sitIdle' : 'none')
      b.look = 'none'
      return
    default:
      return
  }
}

// ── lazer ──────────────────────────────────────────────────────────────────

const spot = { x: 0, z: 0 }

function beginLeisure(b: Brain, l: Leisure, w: BrainWorld): void {
  Object.assign(b, { leisure: l, leisureT: 0, lastLeisure: l, pause: -1, leisureDur: DWELL_MIN + w.rng() * (DWELL_MAX - DWELL_MIN) })
}

/** Começa a conversa (chamado pelo mundo nos DOIS do par). */
export function beginChat(b: Brain, with_: string, lead: boolean, poi: Poi, dur: number): void {
  Object.assign(b, { leisure: 'chat', leisureT: 0, lastLeisure: 'chat', leisureDur: dur, chatWith: with_, chatLead: lead, chatT0: -1, poi, rest: 0, prop: null })
  goStand(b, poi.x, poi.z, poi.yaw, 'walk')
}

function tryLeisure(b: Brain, l: Leisure, w: BrainWorld): boolean {
  if (l === 'chat') return w.pairUp(b)
  if (l === 'phone') {
    if (!w.wander(b, spot)) return false
    beginLeisure(b, 'phone', w)
    goStand(b, spot.x, spot.z, b.yaw, 'stroll')
    return true
  }
  const p = w.claim(b, l)
  if (!p) return false
  b.poi = p
  beginLeisure(b, l, w)
  goStand(b, p.x, p.z, p.yaw, 'walk')
  return true
}

function runFree(b: Brain, dt: number, w: BrainWorld): void {
  if (b.leisure === null) {
    b.prop = null
    if (b.rest > 0 || !b.arrived) {
      // O descanso conta depois de chegar (quem entrou pela porta anda até a mesa antes).
      if (b.arrived) b.rest -= dt
      setAction(b, !b.arrived ? 'none' : b.sit > 0.5 ? 'sitIdle' : 'idle')
      b.look = 'none'
      return
    }
    const start = Math.floor(w.rng() * LEISURES.length)
    for (let i = 0; i < LEISURES.length; i++) {
      const l = LEISURES[(start + i) % LEISURES.length]
      if (l !== b.lastLeisure && tryLeisure(b, l, w)) return
    }
    b.rest = 2 + w.rng() * 2
    return
  }
  if (b.leisure === 'chat') return runChat(b, w)
  if (b.leisure === 'phone') return runPhone(b, dt, w)
  if (!b.arrived) {
    setAction(b, 'none')
    b.look = 'none'
    return
  }
  b.leisureT += dt
  const t = b.leisureT
  const dur = b.leisureDur
  if (b.poi) lookAt(b, b.poi.look.x, b.poi.look.y, b.poi.look.z)
  switch (b.leisure) {
    case 'coffee':
      setAction(b, t < 2.4 ? 'brew' : 'sip')
      b.prop = t < 2.4 ? null : 'cup'
      break
    case 'shelf':
      setAction(b, t < 0.9 ? 'grabBook' : 'readBook')
      b.prop = t > 0.5 ? 'book' : null
      break
    case 'window': {
      const s0 = dur * 0.4
      setAction(b, t >= s0 && t < s0 + 2.4 ? 'stretchUp' : 'lookOut')
      break
    }
    case 'plant':
      setAction(b, 'water')
      b.prop = 'can'
      if (Math.floor(t / 0.3) !== Math.floor((t - dt) / 0.3)) b.fx |= FX.drops
      break
    case 'postit':
      // Só lê e confere o quadro: o kanban é o Quadro real, ninguém prende papel inventado.
      setAction(b, t < dur * 0.6 ? 'readBoard' : 'admire')
      b.prop = null
      break
  }
  if (t >= dur) endLeisure(b, w, 1 + w.rng() * 2.5)
}

function runChat(b: Brain, w: BrainWorld): void {
  const p = w.partner(b)
  if (!p) return endLeisure(b, w, 1 + w.rng() * 2)
  lookAt(b, p.x, 1.25, p.z)
  if (!b.arrived || !p.arrived) {
    setAction(b, b.arrived ? 'idle' : 'none')
    return
  }
  if (b.chatT0 < 0) b.chatT0 = p.chatT0 >= 0 ? p.chatT0 : w.t
  b.leisureT = w.t - b.chatT0
  b.goal.yaw = Math.atan2(-(p.x - b.x), -(p.z - b.z))
  // Revezam a fala a cada 3 s; quem puxou o assunto começa.
  const first = Math.floor(b.leisureT / 3) % 2 === 0
  setAction(b, first === b.chatLead ? 'talk' : 'listen')
  if (b.leisureT >= b.leisureDur) endLeisure(b, w, 1 + w.rng() * 2.5)
}

function runPhone(b: Brain, dt: number, w: BrainWorld): void {
  b.prop = 'phone'
  b.look = 'none'
  setAction(b, 'phone')
  b.leisureT += dt
  if (b.arrived) {
    if (b.pause < 0) b.pause = 1.5 + w.rng() * 1.5
    b.pause -= dt
    if (b.pause <= 0 && w.wander(b, spot)) {
      b.pause = -1
      goStand(b, spot.x, spot.z, b.yaw, 'stroll')
    }
  }
  if (b.leisureT >= b.leisureDur) endLeisure(b, w, 1 + w.rng() * 2)
}

// ── passo ──────────────────────────────────────────────────────────────────

/** Um passo do cérebro: decide o modo, roda o modo e anda. Sem alocação. */
export function stepBrain(b: Brain, dt: number, w: BrainWorld & Partial<BoardWorld>): void {
  b.modeT += dt
  b.actionT += dt
  tickReaction(b, dt)
  const m = decide(b, w)
  if (m !== b.mode) enterMode(b, m, w)
  // Ida ao quadro: no lugar do modo enquanto dura (quem anima tira a tarefa no fim).
  const e = b.errand
  if (e && w.boardSpot && e.state !== 'done' && e.state !== 'aborted') runErrand(b, dt, w as BrainWorld & BoardWorld)
  else runMode(b, dt, w)
  // No trenzinho andando, quem move o corpo é o crowd (a volta em torno do tapete).
  if (!b.puppet) move(b, dt, w)
}

