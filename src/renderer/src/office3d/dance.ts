/**
 * Festa do apagão: poses PURAS (sem three) dos que dançam, do trenzinho, de
 * quem procura o disjuntor com a lanterna e de quem come pizza sentado na mesa.
 * Escrevem os canais de cima (UPPER, como gestures.ts) num `out`
 * reaproveitado; `danceLower` dobra os joelhos no ritmo (só em pé e parado).
 *
 * Música: PARTY_BPM. A batida vem do relógio da CENA (ActionParams.beat =
 * beatAt(t)), o mesmo para todos — o escritório inteiro dança junto. Os quatro
 * passos (DANCE_MOVES) trocam a cada BAR_BEATS batidas, cada agente começando
 * num passo diferente pela seed:
 *   robot  robô: braços em L, tronco e cabeça "travando" a cada meio tempo;
 *   disco  disco apontando: a direita sobe na diagonal e desce cruzando o corpo,
 *          a esquerda na cintura;
 *   sway   balanço: quadril e ombros de um lado para o outro, estalando os dedos;
 *   hop    pulinho: um pulo por batida com os braços para cima.
 */
import { CH, LEG, mix, pulse, smooth, type Action, type ActionParams, type Pose } from './poses'

export const PARTY_BPM = 118
/** Batidas por compasso: o passo da dança troca a cada compasso. */
export const BAR_BEATS = 8
export const DANCE_MOVES = ['robot', 'disco', 'sway', 'hop'] as const satisfies readonly Action[]
export type DanceMove = (typeof DANCE_MOVES)[number]

/** Batida da música no relógio `t` (s) da cena. */
export const beatAt = (t: number): number => (t * PARTY_BPM) / 60

export const isDance = (a: Action): a is DanceMove => a === 'robot' || a === 'disco' || a === 'sway' || a === 'hop'

/** O passo de quem tem a seed `seed` na batida `beat`: troca a cada compasso, todos juntos. */
export function danceMove(seed: number, beat: number): DanceMove {
  const bar = Math.floor(beat / BAR_BEATS)
  const k = Math.floor(Math.abs(seed) * 7) + bar
  return DANCE_MOVES[((k % DANCE_MOVES.length) + DANCE_MOVES.length) % DANCE_MOVES.length]
}

function arms(out: Pose, fL: number, oL: number, eL: number, fR: number, oR: number, eR: number): void {
  out[CH.armFwdL] = fL
  out[CH.armOutL] = oL
  out[CH.elbowL] = eL
  out[CH.armFwdR] = fR
  out[CH.armOutR] = oR
  out[CH.elbowR] = eR
}

/**
 * Canais de cima das ações da festa. `t` = tempo desde o começo da ação (lanterna
 * e pizza); as danças e o trenzinho usam a batida (`p.beat`, ou o próprio t).
 */
export function partyPose(out: Pose, a: Action, t: number, p: ActionParams): void {
  const beat = p.beat ?? beatAt(t)
  const k = p.seed
  switch (a) {
    case 'robot': {
      // Meio tempo "travado": muda de posição de uma vez, sem transição.
      const s = Math.floor(beat * 2) % 4
      const up = s === 0 || s === 3
      arms(out, up ? 1.57 : 0.2, 0.12, 1.57, up ? 0.2 : 1.57, 0.12, 1.57)
      out[CH.twist] = [0.32, 0, -0.32, 0][s]
      out[CH.headYaw] = [-0.45, 0, 0.45, 0][s]
      out[CH.headPitch] = 0
      out[CH.fingersL] = out[CH.fingersR] = 0
      out[CH.mouth] = 0.05
      out[CH.brows] = 0
      return
    }
    case 'disco': {
      // Sobe no 1, desce cruzando no 2 (um ciclo a cada 2 batidas).
      const w = 0.5 - 0.5 * Math.cos(Math.PI * beat)
      arms(out, -0.15, 0.55, 1.9, mix(0.7, 2.75, w), mix(-0.45, 0.55, w), 0.08)
      out[CH.twistL] = 1.1
      out[CH.fingersR] = 0.85
      out[CH.roll] = 0.12 * Math.sin(Math.PI * beat)
      out[CH.twist] = 0.18 * (w - 0.5)
      out[CH.headYaw] = -0.3 * (w - 0.5)
      out[CH.headPitch] = mix(0.25, -0.3, w)
      out[CH.mouth] = 0.25
      out[CH.brows] = 0.4
      return
    }
    case 'sway': {
      const s = Math.sin(Math.PI * beat)
      const snap = pulse(beat % 1, 0, 0.18)
      arms(out, 0.35 + 0.35 * s, 0.25, 0.9 + 0.3 * Math.abs(s), 0.35 - 0.35 * s, 0.25, 0.9 + 0.3 * Math.abs(s))
      out[CH.fingersL] = out[CH.fingersR] = 0.2 + 0.7 * snap
      out[CH.roll] = 0.13 * s
      out[CH.twist] = 0.08 * Math.sin(Math.PI * beat + 0.6)
      out[CH.headRoll] = 0.15 * s
      out[CH.eyes] = 0.55
      out[CH.mouth] = 0.2
      out[CH.brows] = 0.2
      return
    }
    case 'hop': {
      const ph = beat - Math.floor(beat)
      out[CH.hop] = 0.11 * Math.sin(Math.PI * ph)
      const pump = 0.5 + 0.5 * Math.cos(2 * Math.PI * ph)
      arms(out, 2.85, 0.35, 0.5 + 0.45 * pump, 2.85, 0.35, 0.5 + 0.45 * pump)
      out[CH.headPitch] = -0.15
      out[CH.mouth] = 0.6
      out[CH.brows] = 0.8
      out[CH.eyes] = 0.9
      return
    }
    case 'conga': {
      // Mãos nos ombros de quem vai na frente, cabeça no ritmo, cantando.
      arms(out, 1.45, -0.12, 0.5, 1.45, -0.12, 0.5)
      out[CH.fingersL] = out[CH.fingersR] = 0.55
      out[CH.roll] = 0.08 * Math.sin(Math.PI * beat)
      out[CH.headPitch] = 0.05 + 0.08 * Math.max(0, Math.sin(2 * Math.PI * beat))
      out[CH.mouth] = 0.25 + 0.2 * Math.abs(Math.sin(2 * Math.PI * beat))
      out[CH.brows] = 0.5
      return
    }
    case 'flashlight': {
      // Direita com a lanterna varrendo, esquerda tateando no escuro.
      arms(out, 0.55, 0.4, 0.9, 1.4, 0.05, 0.15)
      out[CH.twist] = 0.22 * Math.sin(0.9 * t + k)
      out[CH.headYaw] = 0.3 * Math.sin(0.9 * t + k)
      out[CH.lean] = 0.12
      out[CH.headPitch] = 0.1
      out[CH.fingersR] = 0.9
      out[CH.fingersL] = 0.2
      // De vez em quando: "achei?" (sobrancelhas para cima).
      out[CH.brows] = -0.25 + 0.9 * pulse((t + k) % 4.3, 3.6, 0.35)
      out[CH.mouth] = 0.08
      return
    }
    case 'pizza': {
      // Mordida a cada ~3,4 s; mastiga no resto; a esquerda apoiada na mesa.
      const c = (t + k) % 3.4
      const up = smooth((c - 2.1) / 0.3) * (1 - smooth((c - 2.9) / 0.3))
      arms(out, -0.25, 0.4, 0.25, mix(0.95, 1.35, up), -0.05, mix(1.4, 2.25, up))
      out[CH.twistR] = 0.9 * up
      out[CH.fingersR] = 0.7
      out[CH.mouth] = up > 0.6 ? 0.55 : 0.12 + 0.12 * Math.abs(Math.sin(8 * t))
      out[CH.headPitch] = mix(0.15, -0.05, up)
      out[CH.eyes] = mix(0.85, 0.5, up)
      out[CH.lean] = -0.05
      return
    }
    default:
      return
  }
}

/** Joelhos dobrados em `depth` rad sem tirar os pés do chão (o quadril desce junto). */
function bend(out: Pose, depth: number): void {
  const d = Math.max(0, depth)
  out[CH.legL] = out[CH.legR] = d / 2
  out[CH.kneeL] = out[CH.kneeR] = d
  out[CH.pelvisY] = Math.min(out[CH.pelvisY], 0) - LEG * (1 - Math.cos(d / 2))
}

/** Pernas no ritmo, para quem dança parado em pé (o tronco é do partyPose). */
export function danceLower(out: Pose, a: Action, beat: number): void {
  const ph = beat - Math.floor(beat)
  switch (a) {
    case 'robot':
      return bend(out, 0.16 * (1 - ((beat * 2) % 1)))
    case 'disco':
      return bend(out, 0.26 * (0.5 + 0.5 * Math.cos(2 * Math.PI * ph)))
    case 'sway':
      return bend(out, 0.18 * Math.abs(Math.sin(Math.PI * beat)))
    case 'hop':
      // Aterrissa com os joelhos dobrados; no alto do pulo, pernas encolhidas.
      return bend(out, 0.34 * (1 - Math.sin(Math.PI * ph)) + 0.12 * Math.sin(Math.PI * ph))
    case 'conga':
      return bend(out, 0.14 * Math.abs(Math.sin(Math.PI * beat)))
    default:
      return
  }
}
