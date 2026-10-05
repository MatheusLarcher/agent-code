import { describe, expect, it } from 'vitest'
import { formatMinutos, isValidEstimativa, MAX_ESTIMATIVA_MIN, sumEstimativas } from './planningEstimate'

describe('planningEstimate', () => {
  it('isValidEstimativa: inteiro de 1 a MAX_ESTIMATIVA_MIN', () => {
    for (const ok of [1, 45, MAX_ESTIMATIVA_MIN]) expect(isValidEstimativa(ok), String(ok)).toBe(true)
    for (const bad of [0, -5, 1.5, MAX_ESTIMATIVA_MIN + 1, Number.NaN, Infinity, '45', null, undefined]) {
      expect(isValidEstimativa(bad), String(bad)).toBe(false)
    }
  })

  it('sumEstimativas soma as válidas e conta as etapas sem estimativa', () => {
    expect(sumEstimativas([])).toEqual({ total: 0, semEstimativa: 0 })
    expect(sumEstimativas([{ estimativa: 45 }, {}, { estimativa: 30 }, { estimativa: null }, { estimativa: 0 }])).toEqual({
      total: 75,
      semEstimativa: 3
    })
  })

  it('formatMinutos: minutos abaixo de uma hora, horas e minutos acima', () => {
    expect(formatMinutos(0)).toBe('0 min')
    expect(formatMinutos(45)).toBe('45 min')
    expect(formatMinutos(60)).toBe('1 h')
    expect(formatMinutos(90)).toBe('1 h 30 min')
    expect(formatMinutos(605)).toBe('10 h 5 min')
  })
})
