import { describe, expect, it } from 'vitest'
import { InstancedMesh, Matrix4, Vector3 } from 'three'
import { CONFETTI_BURST, CONFETTI_LIFE, CONFETTI_MAX, Particles } from './particles'

function pools(p: Particles): { confetti: InstancedMesh; puffs: InstancedMesh } {
  const [confetti, puffs] = p.group.children as InstancedMesh[]
  return { confetti, puffs }
}

describe('partículas', () => {
  it('confete pequeno: no máximo 30 no pool, cada estouro ≤ 30, e some em ~1,2 s', () => {
    expect(CONFETTI_MAX).toBeLessThanOrEqual(30)
    expect(CONFETTI_BURST).toBeLessThanOrEqual(CONFETTI_MAX)
    expect(CONFETTI_LIFE).toBeCloseTo(1.2)
    const p = new Particles()
    const { confetti } = pools(p)
    expect(confetti.count).toBe(0)
    p.confettiBurst(0, 1.5, 0)
    expect(p.live).toBe(CONFETTI_BURST)
    // Dois estouros seguidos não passam do pool: recicla os mais velhos.
    p.update(0.1)
    p.confettiBurst(1, 1.5, 0)
    expect(p.live).toBe(CONFETTI_MAX)
    expect(confetti.count).toBe(CONFETTI_MAX)
    let t = 0
    while (p.update(1 / 60)) t += 1 / 60
    expect(t).toBeLessThanOrEqual(CONFETTI_LIFE + 0.05)
    expect(confetti.count).toBe(0)
    p.dispose()
  })

  it('confete sobe, abre e cai; vapor sobe; gota cai', () => {
    const p = new Particles()
    const { confetti, puffs } = pools(p)
    const pos = (im: InstancedMesh, i: number): Vector3 => {
      const m = new Matrix4()
      im.getMatrixAt(i, m)
      return new Vector3().setFromMatrixPosition(m)
    }
    p.confettiBurst(0, 1, 0, 1)
    p.update(0.15)
    expect(pos(confetti, 0).y).toBeGreaterThan(1.1)
    for (let i = 0; i < 40; i++) p.update(1 / 60)
    expect(pos(confetti, 0).y).toBeLessThan(1.6)
    p.puff('steam', 0, 1, 0)
    p.puff('drop', 0, 1, 0)
    p.update(0.3)
    const ys = [pos(puffs, 0).y, pos(puffs, 1).y]
    expect(ys[0]).toBeGreaterThan(1)
    expect(ys[1]).toBeLessThan(1)
    p.dispose()
  })

  it('quem morre sai do desenho (count) sem buraco: as vivas ficam no começo', () => {
    const p = new Particles()
    const { puffs } = pools(p)
    p.puff('drop', 0, 1, 0) // vive ~0,5–0,7 s
    p.puff('steam', 0, 1, 0) // vive ~1,4–1,8 s
    p.puff('steam', 0, 1, 0)
    expect(puffs.count).toBe(3)
    for (let i = 0; i < 50; i++) p.update(1 / 60)
    expect(puffs.count).toBe(2)
    expect(p.live).toBe(2)
    p.dispose()
  })
})
