import { describe, it, expect } from 'vitest'
import { derivePlanningSlug, generatePlanningSlug, PLANNING_SLUG_MAX, slugFromTitle, uniqueSlug } from './planningSlug'

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

describe('generatePlanningSlug', () => {
  // Hora local: é o que o usuário vê no relógio quando cria.
  const at = new Date(2026, 8, 2, 7, 5) // 02/09/2026 07:05

  it('plano-AAAAMMDD-HHMM com zero à esquerda', () => {
    expect(generatePlanningSlug(at, [])).toBe('plano-20260902-0705')
  })

  it('único contra a pasta: -2, -3 no mesmo minuto', () => {
    expect(generatePlanningSlug(at, ['plano-20260902-0705'])).toBe('plano-20260902-0705-2')
    expect(generatePlanningSlug(at, ['plano-20260902-0705', 'plano-20260902-0705-2'])).toBe('plano-20260902-0705-3')
    expect(generatePlanningSlug(at, ['plano-20260902-0706'])).toBe('plano-20260902-0705')
  })

  it('cabe no formato que o main aceita', () => {
    expect(generatePlanningSlug(new Date(2026, 11, 31, 23, 59), [])).toMatch(/^[a-z0-9-]{1,64}$/)
  })
})
