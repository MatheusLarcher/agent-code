import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('vocabulário do ditado no celular', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('a lista do PC corrige o texto transcrito no aparelho', async () => {
    const v = await import('./vocabulary')
    v.setVocabulary(['GitHub', 'backend', 'TypeScript'])
    expect(v.applyVocabulary('subi no git hub o back end em typescript')).toBe('subi no GitHub o backend em TypeScript')
  })

  it('fica guardada no aparelho: vale depois de reabrir, sem o PC', async () => {
    ;(await import('./vocabulary')).setVocabulary(['GitHub'])
    vi.resetModules()
    const reopened = await import('./vocabulary')
    expect(reopened.vocabulary()).toEqual(['GitHub'])
    expect(reopened.applyVocabulary('abre o git hub')).toBe('abre o GitHub')
  })

  it('sem lista o texto passa igual; lixo da rede é descartado', async () => {
    const v = await import('./vocabulary')
    expect(v.applyVocabulary('git hub')).toBe('git hub')
    v.setVocabulary([' GitHub ', 42, null, '', 'x'.repeat(200)])
    expect(v.vocabulary()).toEqual(['GitHub'])
    v.setVocabulary('não é lista')
    expect(v.vocabulary()).toEqual([])
  })
})
