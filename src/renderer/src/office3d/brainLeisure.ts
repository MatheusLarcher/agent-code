/**
 * O lazer do cérebro (modo 'free' de brain.ts) — PURO: cada lazer (café,
 * estante, janela, regar a planta, ler o quadro, conversa com outro ocioso,
 * celular andando) dura de DWELL_MIN a DWELL_MAX s, com uma pausa entre eles;
 * quem acabou de entrar pela porta anda até a mesa antes do descanso contar.
 */
import { DWELL_MAX, DWELL_MIN, endLeisure, FX, goStand, LEISURES, lookAt, setAction, type Brain, type BrainWorld, type Leisure } from './brainBody'
import type { Poi } from './furniture'

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

/** O modo livre: o lazer em curso (ou a pausa e o sorteio do próximo). */
export function runFree(b: Brain, dt: number, w: BrainWorld): void {
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
