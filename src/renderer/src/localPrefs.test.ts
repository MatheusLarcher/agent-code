import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadFlag, readPref, saveFlag, writePref } from './localPrefs'

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('localPrefs: escolhas lembradas no localStorage', () => {
  it('lê e grava texto; sem nada gravado, null', () => {
    expect(readPref('agentcode.teste')).toBeNull()
    writePref('agentcode.teste', 'office')
    expect(readPref('agentcode.teste')).toBe('office')
    expect(localStorage.getItem('agentcode.teste')).toBe('office')
  })

  it("flag: '1' liga, '0' desliga; padrão (ou valor estranho) desligado", () => {
    expect(loadFlag('agentcode.flag')).toBe(false)
    saveFlag('agentcode.flag', true)
    expect(localStorage.getItem('agentcode.flag')).toBe('1')
    expect(loadFlag('agentcode.flag')).toBe(true)
    saveFlag('agentcode.flag', false)
    expect(localStorage.getItem('agentcode.flag')).toBe('0')
    expect(loadFlag('agentcode.flag')).toBe(false)
    localStorage.setItem('agentcode.flag', 'true')
    expect(loadFlag('agentcode.flag')).toBe(false)
  })

  it('sem storage (modo privado, cota): ler volta null e gravar não lança', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(readPref('agentcode.teste')).toBeNull()
    expect(loadFlag('agentcode.flag')).toBe(false)
    expect(() => writePref('agentcode.teste', 'x')).not.toThrow()
    expect(() => saveFlag('agentcode.flag', true)).not.toThrow()
  })
})
