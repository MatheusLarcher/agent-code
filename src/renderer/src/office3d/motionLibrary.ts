/**
 * Os movimentos do Mixamo do Escritório (resources/office-agents/movimentos.bin,
 * gerado por scripts/office-agents/mixamo_motions.mjs): cada clipe é, quadro a
 * quadro, a rotação de cada segmento do corpo no referencial do personagem,
 * relativa ao repouso das poses (tudo zero: tronco na vertical, braços e
 * pernas retos para baixo) — o mesmo espaço dos slots do avatar. Mais a altura
 * e o avanço da bacia (em pernas) e o quanto os dedos fecham. Puro (sem GPU):
 * lê o arquivo e amostra com interpolação; quem aplica é o motionPlayer.ts.
 */
import { Quaternion } from 'three'

export const MOTION_FILE = 'movimentos.bin'
/** Os segmentos, na ordem do arquivo. */
export const MOTION_SLOTS = ['hips', 'spine', 'neck', 'head', 'armL', 'foreL', 'handL', 'armR', 'foreR', 'handR', 'legL', 'kneeL', 'footL', 'legR', 'kneeR', 'footR'] as const
export type MotionSlot = (typeof MOTION_SLOTS)[number]
export const MS: Readonly<Record<MotionSlot, number>> = Object.fromEntries(MOTION_SLOTS.map((k, i) => [k, i])) as Record<MotionSlot, number>
/** Valores por quadro: 4 por segmento + bacia (y, z, x) + dedos (esquerda, direita). */
const PER_FRAME = MOTION_SLOTS.length * 4 + 5

export interface MotionClip {
  key: string
  frames: number
  loop: boolean
  /** Segundos. */
  duration: number
  data: Int16Array
}

/** Uma amostra: a rotação de cada segmento, a bacia (em comprimentos de perna) e os dedos (0..1). */
export interface MotionSample {
  q: Quaternion[]
  hipsY: number
  hipsZ: number
  curlL: number
  curlR: number
}

export const newSample = (): MotionSample => ({ q: MOTION_SLOTS.map(() => new Quaternion()), hipsY: 0, hipsZ: 0, curlL: 0, curlR: 0 })

const qa = new Quaternion()
const qb = new Quaternion()
const Q = 1 / 32767

export class MotionLibrary {
  private readonly clips = new Map<string, MotionClip>()

  constructor(
    readonly fps: number,
    list: MotionClip[]
  ) {
    for (const c of list) this.clips.set(c.key, c)
  }

  /** Lê o arquivo (já sem o gzip); null se o formato não bate. */
  static parse(raw: Uint8Array): MotionLibrary | null {
    if (raw.length < 8 || String.fromCharCode(raw[0], raw[1], raw[2], raw[3]) !== 'MOV1') return null
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
    const len = view.getUint32(4, true)
    if (8 + len > raw.length) return null
    let head: { fps: number; slots: string[]; clips: Array<{ key: string; frames: number; loop: boolean; offset: number }> }
    try {
      head = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + len)))
    } catch {
      return null
    }
    if (!head || !(head.fps > 0) || head.slots?.join() !== MOTION_SLOTS.join()) return null
    const start = 8 + len + ((8 + len) % 2)
    // Uma cópia alinhada (Int16 pede início par no ArrayBuffer).
    const body = raw.slice(start)
    const all = new Int16Array(body.buffer, body.byteOffset, Math.floor(body.byteLength / 2))
    const clips: MotionClip[] = []
    for (const c of head.clips) {
      const from = c.offset / 2
      const n = c.frames * PER_FRAME
      if (from + n > all.length || c.frames < 1) continue
      clips.push({ key: c.key, frames: c.frames, loop: c.loop, duration: c.frames / head.fps, data: all.subarray(from, from + n) })
    }
    return new MotionLibrary(head.fps, clips)
  }

  clip(key: string): MotionClip | null {
    return this.clips.get(key) ?? null
  }

  get size(): number {
    return this.clips.size
  }

  keys(): string[] {
    return [...this.clips.keys()]
  }

  /** A amostra do clipe em `t` s (em laço se `loop`, senão parada no último quadro), interpolada. */
  sample(c: MotionClip, t: number, loop: boolean, out: MotionSample): MotionSample {
    let f = t * this.fps
    if (loop) f = ((f % c.frames) + c.frames) % c.frames
    else f = Math.max(0, Math.min(c.frames - 1, f))
    const i0 = Math.floor(f)
    const i1 = loop ? (i0 + 1) % c.frames : Math.min(c.frames - 1, i0 + 1)
    const k = f - i0
    const d = c.data
    const a = i0 * PER_FRAME
    const b = i1 * PER_FRAME
    for (let s = 0; s < MOTION_SLOTS.length; s++) {
      const o = s * 4
      qa.set(d[a + o] * Q, d[a + o + 1] * Q, d[a + o + 2] * Q, d[a + o + 3] * Q)
      qb.set(d[b + o] * Q, d[b + o + 1] * Q, d[b + o + 2] * Q, d[b + o + 3] * Q)
      out.q[s].slerpQuaternions(qa, qb, k).normalize()
    }
    const e = MOTION_SLOTS.length * 4
    const lerp = (j: number, scale: number): number => (d[a + e + j] + (d[b + e + j] - d[a + e + j]) * k) * scale
    out.hipsY = lerp(0, 1e-4)
    out.hipsZ = lerp(1, 1e-4)
    out.curlL = lerp(3, Q)
    out.curlR = lerp(4, Q)
    return out
  }
}
