import { describe, expect, it, vi } from 'vitest'
import { AUTO_MODEL, PLANNING_AUTO_FALLBACK, type PlanningConfig, type StartAgentOptions } from '../../shared/ipc'
import { PlanningConversations, planningStartOptions, type PlanningStartDeps } from './planningConversations'
import type { PlanningExecution } from './planningModelChoice'

const base: StartAgentOptions = { convId: 'c1', cwd: '/proj', model: AUTO_MODEL, effort: 'max' }

function deps(execution: PlanningExecution, cfg: PlanningConfig = { model: AUTO_MODEL, effort: 'medium' }) {
  const fakes = {
    config: vi.fn(() => cfg),
    resolve: vi.fn(async () => execution)
  }
  return fakes satisfies PlanningStartDeps
}

describe('planningStartOptions', () => {
  it('conversa comum: devolve as MESMAS opções, sem consultar nada', async () => {
    const d = deps({ model: 'claude-opus-5-5', effort: 'high', source: 'manual' })
    const out = await planningStartOptions(base, d)
    expect(out).toBe(base)
    expect(d.config).not.toHaveBeenCalled()
    expect(d.resolve).not.toHaveBeenCalled()
  })

  it('Manager: modelo/esforço do resolvedor, com a config do planejamento e o autoPrompt', async () => {
    const cfg: PlanningConfig = { model: 'claude-opus-5-5', effort: 'high' }
    const d = deps({ model: 'claude-opus-5-5', effort: 'high', source: 'manual' }, cfg)
    const opts = { ...base, planning: { slug: 'checkout' }, autoPrompt: { message: 'separa as etapas' } }
    const out = await planningStartOptions(opts, d)
    expect(d.resolve).toHaveBeenCalledWith(cfg, { message: 'separa as etapas' })
    expect(out).toEqual({ ...opts, model: 'claude-opus-5-5', effort: 'high', loopEnabled: false, economyMode: false })
    // Não muta a entrada.
    expect(opts.model).toBe(AUTO_MODEL)
  })

  it('Manager sobe sem Loop e sem modo econômico, mesmo que a conversa os tenha ligados', async () => {
    const d = deps(fallbackExecution())
    const opts = { ...base, planning: { slug: 'checkout' }, loopEnabled: true, economyMode: true }
    const out = await planningStartOptions(opts, d)
    expect(out.loopEnabled).toBe(false)
    expect(out.economyMode).toBe(false)
    expect(opts.loopEnabled).toBe(true) // não muta a entrada
  })

  it('conversa comum e handoff mantêm os toggles como vieram', async () => {
    const d = deps(fallbackExecution())
    const comum = { ...base, loopEnabled: true, economyMode: true }
    expect(await planningStartOptions(comum, d)).toBe(comum)
    const handoff = { ...base, handoff: { slug: 'checkout' }, loopEnabled: true }
    expect((await planningStartOptions(handoff, d)).loopEnabled).toBe(true)
  })

  it('Manager sem autoPrompt: resolve com mensagem vazia', async () => {
    const d = deps(fallbackExecution())
    await planningStartOptions({ ...base, planning: { slug: 'checkout' } }, d)
    expect(d.resolve).toHaveBeenCalledWith(expect.anything(), { message: '' })
  })

  it('Manager nunca sai com o sentinel do Automático (o autoStart da conversa não pega a sessão)', async () => {
    const d = deps({ model: AUTO_MODEL, effort: 'max', source: 'typesafe' })
    const out = await planningStartOptions({ ...base, planning: { slug: 'checkout' } }, d)
    expect(out.model).toBe(PLANNING_AUTO_FALLBACK.model)
    expect(out.effort).toBe(PLANNING_AUTO_FALLBACK.effort)
  })

  it('usa o resolvedor real quando nada é injetado (config manual, sem TypeSafe)', async () => {
    const out = await planningStartOptions(
      { ...base, planning: { slug: 'checkout' } },
      { config: () => ({ model: 'claude-sonnet-5', effort: 'low' }) }
    )
    expect(out.model).toBe('claude-sonnet-5')
    expect(out.effort).toBe('low')
  })

  it('valida a entrada do IPC: slug inválido e Manager+handoff juntos são recusados', async () => {
    const d = deps(fallbackExecution())
    await expect(planningStartOptions({ ...base, planning: { slug: '../fora' } }, d)).rejects.toThrow(/slug do planejamento inválido/)
    await expect(planningStartOptions({ ...base, handoff: { slug: 'A B' } }, d)).rejects.toThrow(/slug do handoff inválido/)
    await expect(
      planningStartOptions({ ...base, planning: { slug: 'x' }, handoff: { slug: 'x' } }, d)
    ).rejects.toThrow(/ao mesmo tempo/)
    expect(d.resolve).not.toHaveBeenCalled()
  })

  it('handoff válido passa intacto (não é sessão do Manager)', async () => {
    const d = deps(fallbackExecution())
    const opts = { ...base, handoff: { slug: 'checkout' } }
    expect(await planningStartOptions(opts, d)).toBe(opts)
    expect(d.resolve).not.toHaveBeenCalled()
  })
})

describe('PlanningConversations', () => {
  it('conversa comum é observada; a do Manager não', () => {
    const reg = new PlanningConversations()
    reg.track({ convId: 'comum' })
    reg.track({ convId: 'manager', planning: { slug: 'checkout' } })
    expect(reg.observed('comum')).toBe(true)
    expect(reg.observed('manager')).toBe(false)
    expect(reg.observed('nunca-vista')).toBe(true)
  })

  it('a mesma conversa religada sem planning volta a ser observada', () => {
    const reg = new PlanningConversations()
    reg.track({ convId: 'c', planning: { slug: 'checkout' } })
    reg.track({ convId: 'c' })
    expect(reg.observed('c')).toBe(true)
  })

  it('forget limpa a conversa descartada', () => {
    const reg = new PlanningConversations()
    reg.track({ convId: 'c', planning: { slug: 'checkout' } })
    reg.forget('c')
    expect(reg.observed('c')).toBe(true)
  })
})

function fallbackExecution(): PlanningExecution {
  return { ...PLANNING_AUTO_FALLBACK, source: 'fallback' }
}
