import { describe, it, expect } from 'vitest'
import { derivePlanningSlug, PLANNING_SLUG_MAX, slugFromTitle, uniqueSlug } from './planningSlug'

describe('slugFromTitle', () => {
  it('tira acento (NFD) e põe em minúsculas', () => {
    expect(slugFromTitle('Integração de Pagamentos')).toBe('integracao-de-pagamentos')
    expect(slugFromTitle('ÁÉÍÓÚ ãõ ç Ü')).toBe('aeiou-ao-c-u')
  })

  it('símbolos e espaços viram um hífen só, sem hífen nas pontas', () => {
    expect(slugFromTitle('  Checkout / Pix (v2)!!  ')).toBe('checkout-pix-v2')
    expect(slugFromTitle('a__b..c')).toBe('a-b-c')
    expect(slugFromTitle('--já--')).toBe('ja')
  })

  it('só símbolos dá vazio', () => {
    expect(slugFromTitle('?!@#')).toBe('')
    expect(slugFromTitle('   ')).toBe('')
  })

  it('corta em 64 sem terminar em hífen', () => {
    const slug = slugFromTitle(`${'a'.repeat(63)} b`)
    expect(slug.length).toBeLessThanOrEqual(PLANNING_SLUG_MAX)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toMatch(/^[a-z0-9-]{1,64}$/)
  })
})

describe('uniqueSlug / derivePlanningSlug', () => {
  it('livre fica como está', () => {
    expect(uniqueSlug('checkout', ['outro'])).toBe('checkout')
  })

  it('colisão ganha -2, depois -3', () => {
    expect(derivePlanningSlug('Checkout', ['checkout'])).toBe('checkout-2')
    expect(derivePlanningSlug('Checkout', ['checkout', 'checkout-2'])).toBe('checkout-3')
  })

  it('com sufixo o slug continua cabendo em 64', () => {
    const base = 'x'.repeat(64)
    const slug = uniqueSlug(base, [base])
    expect(slug).toHaveLength(64)
    expect(slug.endsWith('-2')).toBe(true)
  })

  it('título sem letra nem número não gera slug', () => {
    expect(derivePlanningSlug('***', [])).toBe('')
  })
})
