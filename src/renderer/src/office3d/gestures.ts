/**
 * Gestos do personagem 3D — PUROS (sem three): o que tronco, braços, cabeça e
 * rosto fazem em cada AÇÃO (digitar, ler a tela, tamborilar, mão no queixo,
 * café, livro, janela, regador, post-it, conversa, celular, fila, cochilo) e em
 * cada REAÇÃO curta (pulinho do "!", susto, estalar os dedos, comemorar,
 * espreguiçar, facepalm, soco no ar, mãos na cabeça, bocejo, relógio, pasta,
 * tchauzinho, joinha, ombros). Escrevem só os canais de cima (UPPER) num `out`
 * reaproveitado; a locomoção e o sentar ficam em poses.ts e as ações da festa
 * do apagão (danças, trenzinho, lanterna, pizza), em dance.ts.
 */

import { partyPose } from './dance'
import { arms, DESK_TOP, EDGE_AHEAD, KEYS_AHEAD, reach, typing } from './reach'
import { CH, envelope, mix, pulse, smooth, type Action, type ActionParams, type Pose } from './poses'

// As reações (pulinho, susto, comemorar…) ficam em reactions.ts; o alcance e o digitar, em reach.ts.
export { reactionPose } from './reactions'

/** Escreve os canais de cima da ação `a` no instante `t` (s desde o início). */
export function actionPose(out: Pose, a: Action, t: number, p: ActionParams): void {
  const k = p.seed
  switch (a) {
    case 'none':
    case 'idle':
      out[CH.headYaw] = 0.22 * Math.sin(0.31 * t + k) + 0.08 * Math.sin(0.83 * t)
      out[CH.twist] += 0.03 * Math.sin(0.4 * t + k)
      out[CH.roll] = 0.02 * Math.sin(0.5 * t + k)
      return
    case 'sitIdle': {
      // Antebraços apoiados na borda do tampo, mãos juntas à frente.
      const r = reach(DESK_TOP + 0.04, EDGE_AHEAD, 0.04, p.scale, p.body)
      arms(out, r.fwd, -0.3, r.elbow, r.fwd, -0.3, r.elbow)
      out[CH.lean] = 0.04
      out[CH.headYaw] = 0.3 * Math.sin(0.27 * t + k)
      out[CH.fingersL] = out[CH.fingersR] = 0.4
      return
    }
    case 'type':
      typing(out, t, 7.5 * p.speed, 0.07, 0.1, p.scale, p.body, !p.seated)
      out[CH.headYaw] = 0.05 * Math.sin(0.9 * t + k)
      return
    case 'typeFast':
      typing(out, t, 13 * p.speed, 0.1, 0.16, p.scale, p.body, !p.seated)
      out[CH.headPitch] = 0.14
      out[CH.brows] = -0.35
      return
    case 'readScreen': {
      // A esquerda no teclado, a direita no mouse (aberta para o lado); olha a tela de perto.
      const r = reach(DESK_TOP + 0.055, KEYS_AHEAD, 0.08, p.scale, p.body)
      arms(out, r.fwd, -0.08, r.elbow, r.fwd, 0.22 + 0.03 * Math.sin(0.7 * t), r.elbow)
      out[CH.lean] = 0.08
      out[CH.headYaw] = 0.22 * Math.sin(1.1 * t + k)
      out[CH.headPitch] = -0.02 + 0.07 * ((t * 0.25) % 1)
      out[CH.fingersR] = 0.2 + 0.5 * pulse(t % 2.3, 1.9, 0.2)
      out[CH.brows] = -0.15
      return
    }
    case 'drum': {
      const r = reach(DESK_TOP + 0.05, EDGE_AHEAD + 0.05, 0.04, p.scale, p.body)
      arms(out, r.fwd, -0.08, r.elbow, r.fwd, -0.1, r.elbow)
      const drumming = t % 1.2 < 0.6
      out[CH.fingersR] = drumming ? 0.2 + 0.5 * Math.abs(Math.sin(12 * t)) : 0.2
      out[CH.elbowR] += drumming ? 0.04 * Math.abs(Math.sin(12 * t)) : 0
      out[CH.lean] = 0.04
      out[CH.roll] = 0.04
      out[CH.headRoll] = 0.12
      out[CH.headPitch] = 0.05
      out[CH.eyes] = 0.72
      return
    }
    case 'web':
      // Recostado, mão direita no queixo (o braço gira para o cotovelo dobrar para dentro).
      arms(out, 1.3, -0.05, 0.75, 1.75, 0, 2.15)
      out[CH.twistR] = 1.2
      out[CH.lean] = -0.2
      out[CH.headPitch] = -0.04
      out[CH.headRoll] = -0.08 + 0.05 * Math.sin(0.4 * t + k)
      out[CH.fingersR] = 0.6
      out[CH.fingersL] = 0.3 + 0.3 * pulse(t % 3.1, 2.4, 0.5)
      out[CH.brows] = 0.2
      return
    case 'assist':
    case 'listen':
      // Braços cruzados.
      arms(out, 0.75, 0, 1.65, 0.75, 0, 1.85)
      out[CH.twistL] = out[CH.twistR] = 1.45
      out[CH.headPitch] = (a === 'assist' ? 0.18 : 0.06) + 0.07 * Math.max(0, Math.sin(2.2 * t + k))
      out[CH.headRoll] = a === 'listen' ? 0.1 : 0
      out[CH.brows] = a === 'assist' ? -0.1 : 0.1
      return
    case 'wave': {
      const s = Math.sin(6.5 * t)
      arms(out, 0.2, 0.35 - 0.15 * s, 0.5, 2.75, 0.25 + 0.22 * s, 0.3 + 0.12 * Math.sin(6.5 * t + 0.5))
      out[CH.brows] = 0.85
      out[CH.mouth] = 0.35 + 0.15 * Math.abs(Math.sin(4 * t))
      out[CH.hop] = 0.025 * Math.abs(Math.sin(5 * t))
      out[CH.twist] = 0.05 * Math.sin(3.2 * t)
      out[CH.headPitch] = -0.1
      return
    }
    case 'brew':
      arms(out, 0.8, 0, 0.6, 1.25, -0.05, 0.35 - 0.3 * (pulse(t, 0.4, 0.25) + pulse(t, 1.2, 0.25)))
      out[CH.lean] = 0.08
      out[CH.headPitch] = 0.3
      return
    case 'sip': {
      const c = (t + k) % 3.6
      const up = smooth((c - 2.3) / 0.35) * (1 - smooth((c - 3.1) / 0.35))
      // Sentado à mesa: o cotovelo fica apoiado acima do tampo e só o antebraço leva a xícara à boca.
      if (p.seated) {
        const r = reach(DESK_TOP + 0.07, EDGE_AHEAD - 0.06, 0, p.scale, p.body)
        arms(out, r.fwd, -0.1, r.elbow, mix(r.fwd, 0.95, up), mix(0.05, -0.2, up), mix(r.elbow, 2.25, up))
      }
      else arms(out, -0.06, 0.1, 0.35, mix(0.75, 0.98, up), -0.1, mix(1.55, 2.25, up))
      out[CH.headPitch] = mix(0.12, -0.2, up)
      out[CH.eyes] = mix(1, 0.4, up)
      out[CH.headYaw] = (1 - up) * 0.2 * Math.sin(0.5 * t + k)
      out[CH.fingersL] = 0.8
      out[CH.prop] = up
      return
    }
    case 'grabBook': {
      const down = smooth((t - 0.55) / 0.35)
      arms(out, mix(0.05, 0.9, down), mix(0.07, -0.2, down), mix(0.14, 1.45, down), mix(2.3, 0.9, down), mix(0.1, -0.2, down), mix(0.25, 1.45, down))
      out[CH.headPitch] = mix(-0.25, 0.42, down)
      return
    }
    case 'readBook': {
      const flip = pulse((t + k) % 2.6, 2.1, 0.4)
      arms(out, 0.9, -0.2, 1.45, 0.9, -0.2 + 0.35 * flip, 1.45 - 0.2 * flip)
      out[CH.headPitch] = 0.42 + 0.03 * Math.sin(0.9 * t)
      out[CH.eyes] = 0.9
      out[CH.brows] = 0.1
      return
    }
    case 'lookOut':
      arms(out, -0.38, 0.08, 0.75, -0.38, 0.08, 0.75)
      out[CH.headPitch] = -0.1
      out[CH.headYaw] = 0.18 * Math.sin(0.25 * t + k)
      out[CH.brows] = 0.2
      out[CH.lean] = -0.02
      return
    case 'stretchUp':
    case 'water':
    case 'readBoard':
    case 'stick':
    case 'admire':
    case 'unpin':
    case 'scribble':
    case 'stamp':
    case 'crumple':
    case 'point':
    case 'talk':
    case 'phone':
    case 'wait':
    case 'napDesk':
    case 'napSofa':
      leisurePose(out, a, t, k)
      return
    case 'robot':
    case 'disco':
    case 'sway':
    case 'hop':
    case 'conga':
    case 'flashlight':
    case 'pizza':
    case 'jump':
      partyPose(out, a, t, p)
      return
  }
}

function leisurePose(out: Pose, a: Action, t: number, k: number): void {
  switch (a) {
    case 'stretchUp': {
      const e = envelope(t, 2.4, 0.5, 0.6)
      arms(out, mix(-0.38, 2.95, e), 0.18, mix(0.75, 0.1, e), mix(-0.38, 2.95, e), 0.18, mix(0.75, 0.1, e))
      out[CH.lean] = -0.18 * e
      out[CH.headPitch] = -0.32 * e
      out[CH.mouth] = 0.65 * e
      out[CH.eyes] = 1 - 0.8 * e
      out[CH.roll] = 0.08 * Math.sin(2 * t) * e
      return
    }
    case 'water':
      arms(out, -0.25, 0.55, 1.65, 1, 0.12, 0.3)
      out[CH.headPitch] = 0.42
      out[CH.lean] = 0.1
      out[CH.prop] = 0.55 + 0.2 * Math.sin(2 * t)
      return
    case 'readBoard':
      // Mão esquerda no queixo, pensativo.
      arms(out, 1.75, 0, 2.15, 0.05, 0.07, 0.14)
      out[CH.twistL] = 1.2
      out[CH.headPitch] = -0.08
      out[CH.headYaw] = 0.25 * Math.sin(0.6 * t + k)
      out[CH.brows] = -0.1
      out[CH.fingersL] = 0.6
      return
    case 'stick': {
      const reach = envelope(t, 1.1, 0.35, 0.3)
      arms(out, 0.05, 0.07, 0.14, mix(0.05, 1.55, reach), 0.05, mix(0.14, 0.15, reach))
      out[CH.lean] = 0.06 * reach + 0.06 * pulse(t, 0.5, 0.25)
      out[CH.headPitch] = -0.05
      return
    }
    case 'unpin': {
      // Braço direito ao papel, pinça e puxa o alfinete.
      const reach = envelope(t, 1, 0.3, 0.25)
      arms(out, 0.05, 0.07, 0.14, mix(0.05, 1.6, reach), 0.05, mix(0.14, 0.3, reach))
      out[CH.fingersR] = smooth((t - 0.35) / 0.15)
      out[CH.lean] = 0.05 * reach - 0.04 * pulse(t, 0.55, 0.25)
      out[CH.headPitch] = -0.05
      return
    }
    case 'scribble': {
      // Papel na esquerda, a direita rabisca em zigue-zague.
      arms(out, 0.95, -0.1, 1.5, 1.05 + 0.06 * Math.sin(14 * t), -0.12 + 0.08 * Math.sin(9 * t + k), 1.45)
      out[CH.headPitch] = 0.4
      out[CH.brows] = -0.15
      out[CH.fingersR] = 0.8
      return
    }
    case 'stamp': {
      // Ergue e bate o carimbo no papel.
      const up = envelope(t, 0.9, 0.3, 0.2)
      const hit = pulse(t, 0.45, 0.18)
      arms(out, 0.05, 0.07, 0.14, mix(1.2, 1.75, up) - 0.35 * hit, 0.05, mix(0.6, 0.9, up))
      out[CH.fingersR] = 1
      out[CH.lean] = 0.08 * hit
      out[CH.brows] = 0.3
      return
    }
    case 'crumple': {
      // Amassa com as duas mãos e arremessa no cesto.
      const ball = smooth(t / 0.6)
      const toss = pulse(t, 0.75, 0.35)
      arms(out, mix(0.9, 0.7, ball), 0.25 * (1 - ball), 1.5, mix(0.9, 0.7, ball) + 1.2 * toss, 0.25 * (1 - ball), 1.5 - 1.1 * toss)
      out[CH.fingersL] = out[CH.fingersR] = 0.6 + 0.4 * Math.abs(Math.sin(12 * t)) * (1 - ball)
      out[CH.headPitch] = 0.35 - 0.3 * toss
      out[CH.prop] = ball
      return
    }
    case 'point':
      // Aponta para o papel e fala.
      arms(out, 0.05, 0.07, 0.14, 1.45, 0.1, 0.05)
      out[CH.fingersR] = 0.9
      out[CH.mouth] = 0.12 + 0.3 * Math.abs(Math.sin(9 * t))
      out[CH.headYaw] = 0.3
      out[CH.brows] = 0.25
      return
    case 'admire':
      arms(out, -0.22, 0.58, 1.7, -0.22, 0.58, 1.7)
      out[CH.headPitch] = -0.05 + 0.05 * Math.sin(3 * t)
      out[CH.brows] = 0.3
      out[CH.roll] = 0.04
      return
    case 'talk':
      arms(
        out,
        0.45 + 0.2 * Math.sin(2.1 * t + 1),
        0.1,
        1 + 0.3 * Math.sin(2.9 * t + 2),
        0.7 + 0.3 * Math.sin(2.7 * t + k),
        0.18 + 0.15 * Math.sin(1.9 * t),
        1.3 + 0.35 * Math.sin(3.3 * t)
      )
      out[CH.mouth] = 0.12 + 0.3 * Math.abs(Math.sin(9 * t))
      out[CH.headPitch] = 0.05 * Math.sin(2.5 * t)
      out[CH.headRoll] = 0.06 * Math.sin(1.3 * t)
      out[CH.brows] = 0.25 + 0.25 * Math.sin(1.7 * t)
      return
    case 'phone': {
      const laugh = pulse((t + k) % 7, 5.8, 0.8)
      arms(out, 0.15, 0.07, 0.35, 0.95, -0.15, 1.45)
      out[CH.thumbR] = 0.5 + 0.5 * Math.sin(4 * t)
      out[CH.headPitch] = 0.55
      out[CH.eyes] = 0.9
      out[CH.shrug] = 0.3 * laugh * Math.abs(Math.sin(20 * t))
      out[CH.mouth] = 0.4 * laugh
      return
    }
    case 'wait':
      arms(out, -0.08, 0.12, 0.4, -0.08, 0.12, 0.4)
      out[CH.fingersL] = out[CH.fingersR] = 0.8
      out[CH.headYaw] = 0.2 * Math.sin(0.4 * t + k)
      out[CH.lean] = -0.02
      return
    case 'napDesk': {
      // Cochilo na estação: debruçado sobre a mesa, a cabeça deitada nos braços cruzados sobre o tampo.
      // Cotovelos abertos apoiados no tampo e as mãos juntas sob a cabeça (ângulos buscados no rig).
      const lean = 1.03 + 0.015 * Math.sin(1.25 * t)
      arms(out, 0.95, 1.35, 1.9, 0.95, 1.35, 1.9)
      out[CH.twistL] = out[CH.twistR] = 1.25
      out[CH.lean] = lean
      out[CH.headPitch] = 0.2
      out[CH.headRoll] = 0.45
      out[CH.eyes] = 0
      out[CH.mouth] = 0.1
      return
    }
    case 'napSofa':
      // Esparramado: afundado, recostado no encosto e com as mãos largadas no colo, meio abertas.
      arms(out, 0.2, 0.12, 0.35, 0.2, 0.12, 0.35)
      out[CH.fingersL] = out[CH.fingersR] = 0.3
      // Reclinado até encostar: as costas ficam ~0,34 m atrás do quadril (o lounge deixa esse vão, officePlan.LOUNGE_SEATS).
      out[CH.lean] = -0.75 + 0.02 * Math.sin(1.2 * t)
      out[CH.headPitch] = 0.08
      out[CH.headRoll] = 0.35
      out[CH.eyes] = 0
      out[CH.mouth] = 0.12 + 0.12 * Math.sin(1.2 * t)
      return
  }
}
