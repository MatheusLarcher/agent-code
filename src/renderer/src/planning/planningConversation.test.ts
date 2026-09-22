import { describe, it, expect } from 'vitest'
import { AUTO_MODEL, isAutoModel } from '@shared/ipc'
import {
  handoffConversationFields,
  isPlanningConversation,
  managerModelLabel,
  planningConversationFields,
  revalidatesAuto,
  sessionStartFields
} from './planningConversation'

const planning = { mode: 'planning' as const, planningSlug: 'checkout', model: 'claude-sonnet-5' }
const normal: { model: string; mode?: 'planning'; planningSlug?: string } = { model: 'claude-opus-5-5' }

describe('isPlanningConversation', () => {
  it('só com mode "planning" E slug', () => {
    expect(isPlanningConversation(planning)).toBe(true)
    expect(isPlanningConversation(normal)).toBe(false)
    expect(isPlanningConversation({ mode: 'planning' })).toBe(false)
    expect(isPlanningConversation({ mode: 'planning', planningSlug: '' })).toBe(false)
    expect(isPlanningConversation(null)).toBe(false)
  })
})

describe('revalidatesAuto', () => {
  it('Automático da conversa normal revalida; planejamento nunca', () => {
    expect(revalidatesAuto({ model: AUTO_MODEL })).toBe(true)
    expect(revalidatesAuto(normal)).toBe(false)
    // Mesmo que o modelo de uma conversa de planejamento caísse no sentinel,
    // quem decide é o main.
    expect(revalidatesAuto({ ...planning, model: AUTO_MODEL })).toBe(false)
  })
})

describe('sessionStartFields', () => {
  const auto = { message: 'monta o plano do checkout', history: [] }

  it('planejamento leva o slug e o prompt de abertura', () => {
    expect(sessionStartFields(planning, auto)).toEqual({ planning: { slug: 'checkout' }, autoPrompt: auto })
    expect(sessionStartFields(planning)).toEqual({ planning: { slug: 'checkout' } })
  })

  it('conversa normal não leva `planning` (e só leva autoPrompt se houver)', () => {
    expect(sessionStartFields(normal)).toEqual({})
    expect(sessionStartFields(normal, auto)).toEqual({ autoPrompt: auto })
  })

  it('conversa de handoff leva `handoff: { slug }` (e nunca `planning`)', () => {
    const impl = { ...normal, handoffSlug: 'checkout' }
    expect(sessionStartFields(impl)).toEqual({ handoff: { slug: 'checkout' } })
    expect(sessionStartFields(impl, auto)).toEqual({ handoff: { slug: 'checkout' }, autoPrompt: auto })
    expect(sessionStartFields({ ...normal, handoffSlug: '' })).toEqual({})
    // Os dois marcados (não deveria acontecer): o main recusaria; o planejamento vence.
    expect(sessionStartFields({ ...planning, handoffSlug: 'x' })).toEqual({ planning: { slug: 'checkout' } })
  })
})

describe('handoffConversationFields', () => {
  it('marca a conversa com o slug e titula "Implementação: <título do plano>"', () => {
    expect(handoffConversationFields('checkout', ' Checkout com Pix ')).toEqual({
      handoffSlug: 'checkout',
      title: 'Implementação: Checkout com Pix'
    })
    expect(handoffConversationFields('checkout').title).toBe('Implementação: checkout')
  })

  it('não mexe em modelo nem em modos: fica o padrão da conversa normal', () => {
    const f = handoffConversationFields('checkout', 'X') as Record<string, unknown>
    for (const key of ['mode', 'planningSlug', 'model', 'effort', 'economyMode', 'loopEnabled', 'fastMode']) {
      expect(f, key).not.toHaveProperty(key)
    }
  })
})

describe('planningConversationFields', () => {
  it('marca a conversa, titula e nasce num modelo concreto (nunca o sentinel)', () => {
    const f = planningConversationFields('checkout', '  Checkout com Pix ')
    expect(f).toMatchObject({ mode: 'planning', planningSlug: 'checkout', title: 'Planejamento: Checkout com Pix' })
    expect(isAutoModel(f.model)).toBe(false)
    expect(f.model).toBeTruthy()
    expect(f.loopEnabled).toBe(false)
    expect(f.economyMode).toBe(false)
  })

  it('reabrir sem título usa o slug', () => {
    expect(planningConversationFields('checkout').title).toBe('Planejamento: checkout')
  })
})

describe('managerModelLabel', () => {
  it('rótulo da lista; id desconhecido volta como está', () => {
    expect(managerModelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(managerModelLabel('modelo-x')).toBe('modelo-x')
  })
})
