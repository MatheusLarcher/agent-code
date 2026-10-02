/**
 * Cérebro na festa do apagão — PURO (sem three). O crowd distribui os papéis
 * (partyPlan.ts) e o brain.ts chama daqui ao entrar e a cada passo do modo
 * 'party':
 *   dance       corre para a vaga da pista, vira para a câmera e dança o passo do
 *               compasso (dance.ts); de vez em quando comemora (confete);
 *   conga       vai até o ponto de partida do trenzinho; quando todos chegam, o
 *               crowd anda com a fila em volta do tapete (posição dada de fora);
 *   flashlight  com a lanterna, passeia devagar pelos móveis apontando cada um
 *               (procurando o disjuntor);
 *   pizza       pula para a beira da própria mesa e come pizza balançando as pernas.
 * Sem plano (corredor, sem sala): dança onde está.
 */
import { danceMove, beatAt, BAR_BEATS } from './dance'
import { goSeat, goStand, lookAt, pushReaction, setAction, stay, type Brain, type BrainWorld } from './brainBody'
import { congaPoint, CONGA_SPEED, danceSpot, FLASH_DWELL, pizzaPerch, type RoomParty } from './partyPlan'
import type { Spot } from './furniture'

/** Depois que a luz volta, quem tem mesa fica sentado nela por isto (s). */
export const BACK_S = 6
/** Chance de comemorar (confete) a cada compasso, para quem dança. */
const CHEER_CHANCE = 0.12

const spot: Spot = { x: 0, z: 0, yaw: 0 }

function goStop(b: Brain, p: RoomParty, i: number): void {
  const s = p.route[i % p.route.length]
  if (s) goStand(b, s.x, s.z, s.yaw, 'stroll')
  else stay(b)
}

/** Entra na festa (o susto do apagão vem do crowd, uma vez): vai para o lugar do papel. */
export function enterParty(b: Brain, w: BrainWorld): void {
  Object.assign(b, { prop: null, look: 'none', faceCamera: false, puppet: false, partyStep: 0, partyT: 0 })
  const p = w.party(b)
  if (!p) return stay(b)
  switch (b.party) {
    case 'dance':
      danceSpot(p.furniture, b.partySlot, spot)
      return goStand(b, spot.x, spot.z, spot.yaw, 'run')
    case 'conga':
      congaPoint(p.loop, p.congaS, b.partySlot, spot)
      return goStand(b, spot.x, spot.z, spot.yaw, 'walk')
    case 'flashlight':
      return goStop(b, p, 0)
    case 'pizza': {
      if (!b.desk) return stay(b)
      const { seat, stand } = pizzaPerch(b.desk)
      return goSeat(b, 'desk', seat.x, seat.z, seat.yaw, stand.x, stand.z, 'walk')
    }
    default:
      return stay(b)
  }
}

/** Um passo na festa. */
export function runParty(b: Brain, dt: number, w: BrainWorld): void {
  const p = w.party(b)
  const beat = beatAt(w.t)
  if (!b.arrived && !b.puppet) {
    b.partyT = 0
    b.look = 'none'
    b.faceCamera = false
    // Quem procura o disjuntor anda com a lanterna em punho.
    if (b.party === 'flashlight') {
      setAction(b, 'flashlight')
      b.prop = 'flashlight'
    } else setAction(b, 'none')
    return
  }
  b.partyT += dt
  switch (p ? b.party : 'dance') {
    case 'conga':
      return runConga(b, p!)
    case 'flashlight': {
      setAction(b, 'flashlight')
      b.prop = 'flashlight'
      const s = p!.route[b.partyStep % p!.route.length]
      if (s) lookAt(b, s.lx, s.ly, s.lz)
      if (b.partyT >= FLASH_DWELL) {
        b.partyStep++
        b.partyT = 0
        goStop(b, p!, b.partyStep)
      }
      return
    }
    case 'pizza':
      setAction(b, b.sit >= 1 ? 'pizza' : 'none')
      b.prop = b.sit >= 1 ? 'pizza' : null
      b.look = 'none'
      return
    default: {
      b.faceCamera = true
      b.look = 'none'
      b.prop = null
      setAction(b, danceMove(b.seed, beat))
      // Virou o compasso: às vezes comemora (com confete).
      const bar = Math.floor(beat / BAR_BEATS)
      if (bar !== Math.floor(beatAt(w.t - dt) / BAR_BEATS) && w.rng() < CHEER_CHANCE) pushReaction(b, 'celebrate')
      return
    }
  }
}

/** Trenzinho: espera os outros no ponto de partida; andando, a posição vem da volta em torno do tapete. */
function runConga(b: Brain, p: RoomParty): void {
  setAction(b, 'conga')
  b.prop = null
  b.look = 'none'
  if (!p.congaGo) return
  // A cada passo (por quadro): campos um a um, sem objeto novo.
  const k = congaPoint(p.loop, p.congaS, b.partySlot, spot)
  b.puppet = true
  b.x = spot.x
  b.z = spot.z
  b.yaw = spot.yaw
  b.speed = CONGA_SPEED * k
  b.atSpot = true
  b.arrived = true
}

/** A luz voltou: sai do papel (a música "para" — susto), corre para a mesa e senta. */
export function leaveParty(b: Brain, t: number): void {
  if (b.party === null) return
  Object.assign(b, { party: null, puppet: false, prop: null, faceCamera: false, rush: true, speed: 0, backUntil: t + BACK_S })
  // Quem estava andando no trenzinho para onde está (o objetivo antigo era a partida).
  b.goal.version++
  b.planned = -1
  b.atSpot = false
  pushReaction(b, 'alert')
}
