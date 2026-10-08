import { describe, it, expect, vi } from 'vitest'
import { AUTO_MODEL, clampEffortToModel, isAutoModel, MODEL_EFFORT } from '@shared/ipc'
import { wantsAutoTitle } from '../conversationTitle'
import {
  existingPlanTitle,
  handoffConversationFields,
  handoffPlanOf,
  isPlanningConversation,
  managerModelLabel,
  planningConversationFields,
  PLANNING_UNTITLED,
  revalidatesAuto,
  sessionStartFields
} from './planningConversation'

const planning = { mode: 'planning' as const, planningSlug: 'checkout', model: 'claude-sonnet-5-5' }
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

  it('só o esforço em Automático também revalida a cada mensagem', () => {
    expect(revalidatesAuto({ ...normal, model: 'claude-opus-5-5', effort: 'auto' })).toBe(true)
    expect(revalidatesAuto({ ...normal, model: 'claude-opus-5-5', effort: 'high' })).toBe(false)
    expect(revalidatesAuto({ ...planning, model: 'claude-opus-5-5', effort: 'auto' })).toBe(false)
  })

  it('handoff segue cada dimensão do Manager: esforço Automático continua Automático', () => {
    expect(handoffConversationFields('x', 'X', { model: 'claude-opus-5-5', effort: 'auto' })).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'auto'
    })
    expect(handoffConversationFields('x', 'X', { model: AUTO_MODEL, effort: 'auto' })).toMatchObject({
      model: AUTO_MODEL,
      effort: 'auto'
    })
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

describe('handoffPlanOf ("Plano: <título>" da conversa de implementação)', () => {
  const opus = { model: 'claude-opus-5-5', effort: 'high' as const }
  const origin = { projectCwd: 'C:\\proj', prompts: ['2026-09-25-01.md', '2026-09-25-02.md'] }

  it('a conversa guarda o plano de origem e os arquivos que recebeu, na ordem', () => {
    expect(handoffConversationFields('checkout', ' Checkout ', opus, origin).handoffPlan).toEqual({
      projectCwd: 'C:\\proj',
      slug: 'checkout',
      titulo: 'Checkout',
      prompts: ['2026-09-25-01.md', '2026-09-25-02.md']
    })
    expect(handoffConversationFields('checkout', 'Checkout', opus).handoffPlan).toBeUndefined()
  })

  it('prefere o título da conversa de planejamento do plano; sem ela, o gravado', () => {
    const conv = { cwd: 'C:\\proj', ...handoffConversationFields('checkout', 'Checkout', opus, origin) }
    const planning = { cwd: 'C:\\proj', mode: 'planning' as const, planningSlug: 'checkout', title: 'Checkout v2' }
    expect(handoffPlanOf(conv, [planning])).toEqual({ projectCwd: 'C:\\proj', slug: 'checkout', titulo: 'Checkout v2' })
    expect(handoffPlanOf(conv, [{ ...planning, cwd: 'C:\\outro' }])?.titulo).toBe('Checkout')
  })

  it('conversa de handoff antiga (só o slug) usa a pasta dela; conversa normal ou de planejamento: nada', () => {
    expect(handoffPlanOf({ cwd: 'C:\\proj', handoffSlug: 'velho' }, [])).toEqual({ projectCwd: 'C:\\proj', slug: 'velho', titulo: 'velho' })
    expect(handoffPlanOf({ cwd: 'C:\\proj' }, [])).toBeNull()
    expect(handoffPlanOf({ cwd: 'C:\\proj', mode: 'planning', planningSlug: 'x', handoffSlug: 'x' }, [])).toBeNull()
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

  it('não vira conversa de planejamento', () => {
    const f = handoffConversationFields('checkout', 'X', opus) as Record<string, unknown>
    for (const key of ['mode', 'planningSlug']) {
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
    plan: {
      slug: 'checkout',
      dir: '/dados/planning/proj/checkout',
      sandboxDir: '/proj/docs/spec/checkout/_sandbox',
      roteiro: { titulo, rev: 2, etapas: [] },
      cards: [],
      layout: { positions: {} },
      invalid: [],
      media: []
    }
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
    expect(managerModelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
    expect(managerModelLabel('modelo-x')).toBe('modelo-x')
  })
})
