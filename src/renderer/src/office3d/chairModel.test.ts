import { describe, expect, it } from 'vitest'
import { ARM_TOP, CHAIR_CENTER_Z, officeChairGeometries, SEAT_TOP } from './chairModel'
import { DESK_HEIGHT } from './officePlan'

/** A face de baixo do tampo da estação (o tampo tem 5 cm, centrado em DESK_HEIGHT). */
const DESK_UNDER = DESK_HEIGHT - 0.025

describe('a cadeira de escritório (chairModel.ts) no assento padrão', () => {
  it('o assento fica na faixa da norma (NBR 13962: 0,42–0,52 m) e o apoio dos braços abaixo do tampo', () => {
    expect(SEAT_TOP).toBeGreaterThanOrEqual(0.42)
    expect(SEAT_TOP).toBeLessThanOrEqual(0.52)
    expect(ARM_TOP).toBeLessThan(DESK_UNDER)
  })

  it('o metal: os braços inteiros abaixo do tampo e nada (coluna a gás, suporte, braços) dentro do estofado do assento', () => {
    const { top, base } = officeChairGeometries()
    const pos = base.attributes.position
    const high: string[] = []
    const inSeat: string[] = []
    for (let i = 0; i < pos.count; i++) {
      const [x, y, z] = [pos.getX(i), pos.getY(i), pos.getZ(i)]
      const at = `${x.toFixed(2)},${y.toFixed(3)},${z.toFixed(2)}`
      // Dos lados do assento (os braços e as colunas deles): abaixo da face de baixo do tampo.
      if (Math.abs(x) > 0.25 && y >= DESK_UNDER) high.push(at)
      // O estofado do assento (0,64 × 0,14 × 0,62, topo em SEAT_TOP), com 5 mm de folga nas bordas.
      if (Math.abs(x) < 0.315 && y > SEAT_TOP - 0.135 && y < SEAT_TOP - 0.005 && Math.abs(z - CHAIR_CENTER_Z) < 0.305) inSeat.push(at)
    }
    top.dispose()
    base.dispose()
    expect(high.slice(0, 5)).toEqual([])
    expect(inSeat.slice(0, 5)).toEqual([])
  })
})
