import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MOTION_FILE, MotionLibrary, newSample } from './motionLibrary'
import { pickMotion } from './motionPick'
import type { Action, Reaction } from './poses'

/** O arquivo de verdade (resources/office-agents/movimentos.bin, gerado do Mixamo). */
const PATH = join(process.cwd(), 'resources', 'office-agents', MOTION_FILE)

describe.runIf(existsSync(PATH))('movimentos.bin (os clipes do Mixamo)', () => {
  let cached: MotionLibrary | null = null
  const load = (): MotionLibrary => (cached ??= MotionLibrary.parse(new Uint8Array(gunzipSync(readFileSync(PATH))))!)

  it('abre, e todo clipe amostra quaternions unitários e a bacia num intervalo de corpo humano', () => {
    const lib = load()
    expect(lib).not.toBeNull()
    expect(lib.size).toBeGreaterThan(60)
    const s = newSample()
    for (const key of lib.keys()) {
      const c = lib.clip(key)!
      for (const t of [0, c.duration / 3, c.duration * 0.9]) {
        lib.sample(c, t, c.loop, s)
        for (const q of s.q) expect(Math.abs(q.length() - 1), key).toBeLessThan(1e-3)
        expect(Math.abs(s.hipsY), key).toBeLessThan(1.2)
      }
    }
  })

  it('o repouso de quem está à toa é de pé: a bacia na altura e as pernas quase na vertical', () => {
    const lib = load()
    const s = newSample()
    lib.sample(lib.clip('idleBreath')!, 1, true, s)
    expect(Math.abs(s.hipsY)).toBeLessThan(0.08)
    // Coxa e canela (legL, kneeL) longe da horizontal.
    for (const i of [10, 11]) expect(s.q[i].angleTo(newSample().q[0])).toBeLessThan(0.5)
  })

  it('cada ação e reação que tem movimento acha um clipe que existe', () => {
    const lib = load()
    const has = (k: string): boolean => lib.clip(k) !== null
    const actions: Action[] = ['idle', 'talk', 'listen', 'phone', 'wave', 'jump', 'lookOut', 'readBoard', 'stretchUp', 'sip', 'robot', 'disco', 'sway', 'hop']
    for (const action of actions) expect(pickMotion({ action, reaction: null, sit: 0, seat: null, speed: 0, prop: null, seed: 0.2, t: 3 }, has), action).not.toBeNull()
    const reactions: Reaction[] = ['alert', 'scared', 'celebrate', 'facepalm', 'fistpump', 'handsHead', 'yawn', 'thumbsUp', 'shrug', 'greet']
    for (const reaction of reactions) expect(pickMotion({ action: 'idle', reaction, sit: 0, seat: null, speed: 0, prop: null, seed: 0.2, t: 3 }, has), reaction).not.toBeNull()
    expect(pickMotion({ action: 'none', reaction: null, sit: 0, seat: null, speed: 1.1, prop: null, seed: 0.2, t: 3 }, has)?.key).toMatch(/walk/i)
    expect(pickMotion({ action: 'sitIdle', reaction: null, sit: 1, seat: 'chair', speed: 0, prop: null, seed: 0.2, t: 3 }, has)?.key).toMatch(/^sit/)
  })
})
