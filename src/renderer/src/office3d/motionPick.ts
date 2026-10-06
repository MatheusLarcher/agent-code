/**
 * Qual movimento do Mixamo cada agente faz agora — PURO. Pela ação e pela
 * reação do cérebro, se está sentado (cadeira) e se está andando, escolhe o
 * clipe, a parte do corpo que ele move e o tempo dentro dele:
 *
 *   reação (curta, uma vez)  > ação (em laço)  > andar  > parado à toa (variações)
 *
 * Sentado na cadeira, o clipe move só o tronco, a cabeça e os braços (as pernas
 * e a bacia ficam as do assento, feitas para a mesa). Andando com objeto na mão,
 * só as pernas. Digitar, cochilar, as idas ao quadro, o trenzinho, a lanterna e
 * a pizza seguem procedurais (feitos sob medida para a mesa, o quadro e a festa).
 * A variação sai da seed: cada agente tem o seu jeito, e muda de tempos em tempos.
 */
import type { Action, Reaction } from './poses'

export type MotionMask = 'full' | 'upper' | 'lower'

export interface MotionPick {
  key: string
  mask: MotionMask
  /** true: em laço pelo relógio; false: uma vez, a partir do começo (reação). */
  loop: boolean
  /** Sincronizado com o passo (0..1 do ciclo da passada): o tempo vem da fase, não do relógio. */
  phase: boolean
}

export interface MotionState {
  action: Action
  reaction: Reaction | null
  /** 0 em pé … 1 sentado. */
  sit: number
  seat: string | null
  speed: number
  /** Objeto na mão direita. */
  prop: string | null
  seed: number
  /** Relógio da cena (s): troca a variação de tempos em tempos. */
  t: number
}

/** Ações em pé → clipes (variações). */
const STAND: Partial<Record<Action, readonly string[]>> = {
  idle: ['idleBreath', 'idleShift', 'idleHappy', 'idleHappy2', 'idleNeutral', 'idleLook', 'idleLook2', 'idleBored'],
  none: ['idleBreath', 'idleShift', 'idleNeutral', 'idleHappy'],
  wait: ['idleBored', 'idleNervous', 'idleShift'],
  talk: ['talk', 'talkAsk', 'talkCooler', 'talkFunny', 'talkAsk2'],
  listen: ['nodYes', 'nodThought', 'agree', 'acknowledge'],
  phone: ['phoneTalk', 'texting', 'texting2'],
  wave: ['wave', 'waveBoth'],
  jump: ['excited', 'jump'],
  lookOut: ['idleLook', 'idleLook2'],
  readBoard: ['thinking'],
  admire: ['clap', 'thinking'],
  stretchUp: ['armStretch', 'neckStretch'],
  sip: ['drink'],
  point: ['point', 'pointForward'],
  robot: ['danceRobot', 'danceTut', 'danceSnake'],
  disco: ['danceSide', 'danceTwistSilly', 'danceGangnam', 'danceMacarena', 'danceChicken', 'danceTwist', 'danceShuffle', 'danceArms', 'danceWave', 'danceRunningMan', 'danceHouse', 'danceBoogaloo', 'danceThriller', 'danceCabbage'],
  sway: ['danceSalsa', 'danceSamba', 'danceCharleston'],
  hop: ['jumpingJacks', 'danceChicken']
}

/** Ações sentado na cadeira → clipes (só o tronco e os braços). */
const SEATED: Partial<Record<Action, readonly string[]>> = {
  sitIdle: ['sitIdle', 'sitThighs', 'sitStill', 'sitLook'],
  readScreen: ['sitIdle', 'sitStill', 'sitThighs'],
  none: ['sitIdle', 'sitStill'],
  drum: ['sitImpatient'],
  talk: ['sitTalk', 'sitTalk2'],
  listen: ['sitIdle', 'sitLook'],
  assist: ['sitTalk2', 'sitPoint'],
  sip: ['sitDrink'],
  wait: ['sitImpatient', 'sitLook']
}

const STAND_REACT: Partial<Record<Reaction, readonly string[]>> = {
  alert: ['surprised', 'surprisedWiggle'],
  scared: ['terrified'],
  celebrate: ['victory', 'cheer', 'laugh'],
  stretch: ['armStretch', 'neckStretch', 'relieved'],
  facepalm: ['disappointed', 'headShake'],
  fistpump: ['fistPump', 'fistPumpBig'],
  handsHead: ['defeated'],
  yawn: ['yawn'],
  watch: ['tapWrist'],
  thumbsUp: ['thumbsUp'],
  shrug: ['shrug', 'dismiss'],
  greet: ['wave', 'waveBoth']
}

const SEATED_REACT: Partial<Record<Reaction, readonly string[]>> = {
  alert: ['sitYell'],
  celebrate: ['sitVictory', 'sitCheer', 'sitClap', 'sitLaugh'],
  facepalm: ['sitHeadHands', 'sitDisapprove'],
  handsHead: ['sitHeadBack', 'sitHeadHands'],
  fistpump: ['sitFistPump'],
  thumbsUp: ['sitThumbs'],
  stretch: ['sitWake'],
  shrug: ['sitAngry']
}

/** Quanto dura (s) cada variação de quem está à toa em laço antes de trocar. */
export const VARIANT_S = 14

/** Escolhe uma das opções que existem na biblioteca, pela seed e pela "época" (estável dentro dela). */
function choose(list: readonly string[] | undefined, seed: number, epoch: number, has: (k: string) => boolean): string | null {
  if (!list) return null
  const ok = list.filter(has)
  if (!ok.length) return null
  const h = Math.abs(Math.sin(seed * 12.9898 + epoch * 78.233) * 43758.5453) % 1
  return ok[Math.floor(h * ok.length) % ok.length]
}

/** O movimento de agora (null: só o procedural). `has` diz se o clipe existe na biblioteca. */
export function pickMotion(s: MotionState, has: (key: string) => boolean): MotionPick | null {
  // Sentando ou levantando: o procedural (o assento e o rumo dele).
  if (s.sit > 0.02 && s.sit < 0.98) return null
  const chair = s.sit >= 0.98 && s.seat === 'chair'
  if (s.sit >= 0.98 && !chair) return null
  const epoch = Math.floor((s.t + s.seed * 31) / VARIANT_S)
  if (s.reaction) {
    const key = choose(chair ? SEATED_REACT[s.reaction] : STAND_REACT[s.reaction], s.seed, Math.floor(s.t / 3), has)
    if (key) return { key, mask: chair || s.speed > 0.15 ? 'upper' : 'full', loop: false, phase: false }
  }
  if (chair) {
    const key = choose(SEATED[s.action], s.seed, epoch, has)
    return key ? { key, mask: 'upper', loop: true, phase: false } : null
  }
  if (s.speed > 0.15) {
    const run = s.speed > 2.2 ? choose(['sprint', 'jog'], s.seed, 0, has) : s.speed > 1.4 ? choose(['jog'], s.seed, 0, has) : null
    const key = run ?? choose(['walk', 'walkHappy'], s.seed, epoch, has)
    // Com objeto na mão, ou fazendo algo com os braços enquanto anda (celular, plaquinha), só as pernas.
    const busyArms = !!s.prop || (s.action !== 'none' && s.action !== 'idle')
    return key ? { key, mask: busyArms ? 'lower' : 'full', loop: true, phase: true } : null
  }
  const key = choose(STAND[s.action], s.seed, epoch, has)
  return key ? { key, mask: 'full', loop: true, phase: false } : null
}
