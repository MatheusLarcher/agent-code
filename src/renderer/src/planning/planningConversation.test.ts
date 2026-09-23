import { describe, it, expect, vi } from 'vitest'
import { AUTO_MODEL, clampEffortToModel, isAutoModel, MODEL_EFFORT } from '@shared/ipc'
import { wantsAutoTitle } from '../conversationTitle'
import {
  existingPlanTitle,
  handoffConversationFields,
  isPlanningConversation,
  managerModelLabel,
  planningConversationFields,
  PLANNING_UNTITLED,
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
  const opus = { model: 'claude-opus-5-5', effort: 'high' as const }

  it('marca a conversa com o slug e titula "Implementação: <título do plano>"', () => {
    expect(handoffConversationFields('checkout', ' Checkout com Pix ', opus)).toMatchObject({
      handoffSlug: 'checkout',
      title: 'Implementação: Checkout com Pix'
    })
    expect(handoffConversationFields('checkout', undefined, opus).title).toBe('Implementação: checkout')
  })

  it('nasce com o modelo e o esforço do Agent Manager (o último escolhido no planejamento)', () => {
    expect(handoffConversationFields('checkout', 'X', opus)).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      fastMode: false
    })
  })

  it('Automático no planejamento → Automático na implementação (o sentinel, revalidado a cada mensagem)', () => {
    const f = handoffConversationFields('checkout', 'X', { model: AUTO_MODEL, effort: 'medium' })
    expect(isAutoModel(f.model)).toBe(true)
    expect(revalidatesAuto({ ...f, mode: undefined, planningSlug: undefined })).toBe(true)
  })

  it('esforço que o modelo não aceita é ajustado ao dele', () => {
    for (const model of Object.keys(MODEL_EFFORT)) {
      for (const effort of ['low', 'xhigh', 'max'] as const) {
        const f = handoffConversationFields('checkout', 'X', { model, effort })
        expect(f.effort, `${model}/${effort}`).toBe(clampEffortToModel(model, effort))
      }
    }
  })

  it('não vira conversa de planejamento nem mexe em loop/econômico', () => {
    const f = handoffConversationFields('checkout', 'X', opus) as Record<string, unknown>
    for (const key of ['mode', 'planningSlug', 'economyMode', 'loopEnabled']) {
      expect(f, key).not.toHaveProperty(key)
    }
  })
})

describe('planningConversationFields', () => {
  it('marca a conversa, leva o mesmo nome do roteiro e nasce num modelo concreto (nunca o sentinel)', () => {
    const f = planningConversationFields('checkout', '  Checkout com Pix ')
    expect(f).toMatchObject({ mode: 'planning', planningSlug: 'checkout', title: 'Checkout com Pix' })
    expect(isAutoModel(f.model)).toBe(false)
    expect(f.model).toBeTruthy()
    expect(f.loopEnabled).toBe(false)
    expect(f.economyMode).toBe(false)
  })

  it('reabrir sem título usa o slug', () => {
    expect(planningConversationFields('checkout').title).toBe('Planejamento: checkout')
  })

  it('plano criado sem nome: a conversa nasce "Sem nome" (entra no título automático)', () => {
    expect(PLANNING_UNTITLED).toBe('Sem nome')
    expect(planningConversationFields('plano-20260922-1430', PLANNING_UNTITLED).title).toBe('Sem nome')
  })
})

describe('existingPlanTitle (reabrir um plano existente)', () => {
  const ref = { projectCwd: '/proj', slug: 'checkout' }
  const opened = (titulo: string) => ({
    ok: true as const,
    plan: { slug: 'checkout', roteiro: { titulo, rev: 2, etapas: [] }, cards: [], layout: { positions: {} }, invalid: [] }
  })

  it('usa o título do roteiro (planningOpen), não o slug — e não fecha a vigia', async () => {
    const api = { planningOpen: vi.fn(async () => opened('  Checkout com Pix ')), planningClose: vi.fn() }
    const titulo = await existingPlanTitle(api, ref)
    expect(titulo).toBe('Checkout com Pix')
    expect(api.planningOpen).toHaveBeenCalledWith(ref)
    expect(api.planningClose).not.toHaveBeenCalled()
    const conv = planningConversationFields('checkout', titulo)
    expect(conv.title).toBe('Checkout com Pix')
    // Nome de verdade: nada automático mexe nele.
    expect(wantsAutoTitle(conv, 'primeira mensagem')).toBe(false)
  })

  it('plano "Sem nome": a conversa nasce "Sem nome" e entra no título automático normal', async () => {
    const titulo = await existingPlanTitle({ planningOpen: async () => opened(PLANNING_UNTITLED) }, ref)
    expect(titulo).toBe('Sem nome')
    const conv = planningConversationFields('checkout', titulo)
    expect(conv.title).toBe('Sem nome')
    expect(wantsAutoTitle(conv, 'quero planejar o checkout')).toBe(true)
  })

  it('título vazio, plano ilegível ou IPC fora: undefined (a conversa fica com o slug); nunca lança', async () => {
    const cases = [
      async () => opened('   '),
      async () => ({ ok: false as const, code: 'invalid' as const, message: 'roteiro quebrado' }),
      async () => {
        throw new Error('canal fechado')
      }
    ]
    for (const planningOpen of cases) {
      const titulo = await existingPlanTitle({ planningOpen } as never, ref)
      expect(titulo).toBeUndefined()
      expect(planningConversationFields('checkout', titulo).title).toBe('Planejamento: checkout')
    }
  })
})

describe('managerModelLabel', () => {
  it('rótulo da lista; id desconhecido volta como está', () => {
    expect(managerModelLabel('claude-sonnet-5')).toBe('Sonnet 5')
    expect(managerModelLabel('modelo-x')).toBe('modelo-x')
  })
})
