import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { legScale } from './agentRest'
import { BODY } from './poses'

describe('escala do avatar pelas pernas', () => {
  it('perna de desenho (curta) cresce até a do boneco: o joelho chega à altura das cadeiras', () => {
    // As medidas do v1: tornozelo 0,125 m acima da sola, coxa 0,387 e canela 0,321 (1,83 m no total).
    const k = legScale(-0.916, new Vector3(0.105, -0.089, 0), new Vector3(0.105, -0.476, 0), new Vector3(0.105, -0.797, 0))
    expect(k).toBeCloseTo((BODY.ankleY + BODY.thigh + BODY.shin) / (0.119 + 0.387 + 0.321), 3)
    expect(k).toBeGreaterThan(1.15)
  })

  it('perna igual à do boneco não muda; esqueleto sem perna medível fica como está', () => {
    const top = BODY.ankleY + BODY.shin + BODY.thigh
    expect(legScale(0, new Vector3(0, top, 0), new Vector3(0, BODY.ankleY + BODY.shin, 0), new Vector3(0, BODY.ankleY, 0))).toBeCloseTo(1, 6)
    expect(legScale(0, new Vector3(), new Vector3(), new Vector3())).toBe(1)
  })
})
