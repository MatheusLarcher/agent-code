import { describe, expect, it, vi } from 'vitest'
import type { PlanningRoteiroDto, RateLimitStatus } from '@shared/ipc'
import {
  claudeUsageAllowsLlmTitle,
  deriveTitle,
  isDefaultTitle,
  requestLlmTitle,
  syncRoteiroTitle,
  wantsAutoTitle,
  withFallbackTitle,
  withLlmTitle,
  withUserTitle,
  type RoteiroTitleSyncDeps
} from './conversationTitle'
import { PLANNING_UNTITLED } from './planning/planningConversation'
import { DEFAULT_TITLE } from './types'

const fresh = { title: DEFAULT_TITLE } as { title: string; titleSource?: 'auto' | 'llm' | 'user' }

describe('recuo e origem do título', () => {
  it('deriveTitle: primeira linha, até 48 caracteres', () => {
    expect(deriveTitle('  corrige o login\nsegunda linha')).toBe('corrige o login')
    expect(deriveTitle('a'.repeat(60))).toBe(`${'a'.repeat(48)}…`)
    expect(deriveTitle('   ')).toBe(DEFAULT_TITLE)
  })

  it('títulos de nascimento: conversa nova e planejamento sem nome', () => {
    expect(isDefaultTitle(DEFAULT_TITLE)).toBe(true)
    expect(isDefaultTitle(PLANNING_UNTITLED)).toBe(true)
    expect(isDefaultTitle('Planejamento: checkout')).toBe(false)
  })

  it('só a 1ª mensagem com texto, e nunca depois de o usuário renomear', () => {
    expect(wantsAutoTitle(fresh, 'oi')).toBe(true)
    expect(wantsAutoTitle({ title: PLANNING_UNTITLED }, 'monta o plano')).toBe(true)
    expect(wantsAutoTitle(fresh, '  ')).toBe(false) // só imagem: espera a próxima com texto
    expect(wantsAutoTitle({ title: 'Checkout', titleSource: 'auto' }, 'oi')).toBe(false)
    expect(wantsAutoTitle({ title: DEFAULT_TITLE, titleSource: 'user' }, 'oi')).toBe(false)
  })

  it('withFallbackTitle aplica o recuo com origem "auto"', () => {
    expect(withFallbackTitle(fresh, 'corrige o login')).toEqual({ title: 'corrige o login', titleSource: 'auto' })
    const named = { title: 'Meu nome', titleSource: 'user' as const }
    expect(withFallbackTitle(named, 'oi')).toBe(named)
  })

  it('withLlmTitle só entra por cima do recuo', () => {
    expect(withLlmTitle({ title: 'corrige o login', titleSource: 'auto' }, ' Login com SSO ')).toEqual({
      title: 'Login com SSO',
      titleSource: 'llm'
    })
    for (const c of [
      { title: 'Meu nome', titleSource: 'user' as const },
      { title: 'Outro', titleSource: 'llm' as const },
      { title: 'Antiga' }
    ]) {
      expect(withLlmTitle(c, 'Nome do LLM')).toBe(c)
    }
    const auto = { title: 'x', titleSource: 'auto' as const }
    expect(withLlmTitle(auto, '   ')).toBe(auto)
  })

  it('withUserTitle trava; nome vazio não muda nada', () => {
    expect(withUserTitle({ title: 'x', titleSource: 'llm' }, '  Meu nome ')).toEqual({ title: 'Meu nome', titleSource: 'user' })
    const c = { title: 'x', titleSource: 'auto' as const }
    expect(withUserTitle(c, '   ')).toBe(c)
  })
})

describe('claudeUsageAllowsLlmTitle', () => {
  const now = 1_000_000
  const win = (over: Partial<RateLimitStatus>): RateLimitStatus => ({
    rateLimitType: 'five_hour',
    status: 'allowed',
    utilization: 0.5,
    resetsAt: now + 60_000,
    ...over
  })

  it('sem dado nenhum (chave de API) ou todas até 90% → pode', () => {
    expect(claudeUsageAllowsLlmTitle({}, now)).toBe(true)
    expect(
      claudeUsageAllowsLlmTitle({ five_hour: win({ utilization: 0.9 }), seven_day: win({ rateLimitType: 'seven_day', utilization: 0.2 }) }, now)
    ).toBe(true)
  })

  it('qualquer janela do Claude acima de 90% → não pode', () => {
    expect(claudeUsageAllowsLlmTitle({ seven_day: win({ rateLimitType: 'seven_day', utilization: 0.91 }) }, now)).toBe(false)
    expect(claudeUsageAllowsLlmTitle({ five_hour: win({ utilization: 0.5 }), overage: win({ rateLimitType: 'overage', utilization: 0.95 }) }, now)).toBe(false)
  })

  it('janelas do GPT não contam; janela que já virou também não', () => {
    expect(claudeUsageAllowsLlmTitle({ gpt_primary: win({ rateLimitType: 'gpt_primary', utilization: 1 }) }, now)).toBe(true)
    expect(claudeUsageAllowsLlmTitle({ five_hour: win({ utilization: 0.99, resetsAt: now - 1 }) }, now)).toBe(true)
  })
})

describe('requestLlmTitle', () => {
  it('ok → título; ok:false, exceção ou canal ausente → null', async () => {
    await expect(requestLlmTitle({ suggestConversationTitle: async () => ({ ok: true, title: ' Pix ' }) }, 'x')).resolves.toBe('Pix')
    await expect(requestLlmTitle({ suggestConversationTitle: async () => ({ ok: false }) }, 'x')).resolves.toBeNull()
    await expect(
      requestLlmTitle(
        {
          suggestConversationTitle: async () => {
            throw new Error('canal fechado')
          }
        },
        'x'
      )
    ).resolves.toBeNull()
    await expect(requestLlmTitle({} as never, 'x')).resolves.toBeNull()
  })
})

describe('syncRoteiroTitle', () => {
  const ref = { projectCwd: 'C:/proj', slug: 'plano-20260922-1430' }
  const roteiro = (over: Partial<PlanningRoteiroDto> = {}): PlanningRoteiroDto => ({
    titulo: PLANNING_UNTITLED,
    rev: 3,
    etapas: [{ id: 'requisitos', titulo: 'Requisitos', status: 'pendente' }],
    ...over
  })

  function deps(onScreen = false) {
    const api = {
      planningOpen: vi.fn(async () => ({
        ok: true as const,
        plan: { slug: ref.slug, roteiro: roteiro(), cards: [], layout: { positions: {} }, invalid: [] }
      })),
      planningClose: vi.fn(async () => ({ ok: true as const })),
      planningSaveRoteiro: vi.fn(async (req: { roteiro: { titulo: string; etapas: PlanningRoteiroDto['etapas'] }; expectedRev: number }) => ({
        ok: true as const,
        roteiro: { ...req.roteiro, rev: req.expectedRev + 1 }
      }))
    }
    const d: RoteiroTitleSyncDeps = { api: api as unknown as RoteiroTitleSyncDeps['api'], isOnScreen: () => onScreen }
    return { api, d }
  }

  it('grava o título mantendo as etapas, com o rev lido (expectedRev)', async () => {
    const { api, d } = deps()
    await expect(syncRoteiroTitle(ref, ' Checkout com Pix ', d)).resolves.toBe(true)
    expect(api.planningOpen).toHaveBeenCalledWith(ref)
    expect(api.planningSaveRoteiro).toHaveBeenCalledWith({
      ...ref,
      roteiro: { titulo: 'Checkout com Pix', etapas: roteiro().etapas },
      expectedRev: 3
    })
  })

  it('roteiro_conflict: reaplica UMA vez sobre o roteiro atual', async () => {
    const { api, d } = deps()
    const current = roteiro({ rev: 5, etapas: [{ id: 'nova', titulo: 'Nova', status: 'em_andamento' }] })
    api.planningSaveRoteiro.mockResolvedValueOnce({ ok: false, code: 'roteiro_conflict', message: 'x', current } as never)
    await expect(syncRoteiroTitle(ref, 'Checkout', d)).resolves.toBe(true)
    expect(api.planningSaveRoteiro).toHaveBeenCalledTimes(2)
    expect(api.planningSaveRoteiro.mock.calls[1][0]).toEqual({
      ...ref,
      roteiro: { titulo: 'Checkout', etapas: current.etapas },
      expectedRev: 5
    })
  })

  it('conflito de novo na retentativa: desiste (false), sem terceira gravação', async () => {
    const { api, d } = deps()
    const conflict = { ok: false, code: 'roteiro_conflict', message: 'x', current: roteiro({ rev: 9 }) } as never
    api.planningSaveRoteiro.mockResolvedValueOnce(conflict).mockResolvedValueOnce(conflict)
    await expect(syncRoteiroTitle(ref, 'Checkout', d)).resolves.toBe(false)
    expect(api.planningSaveRoteiro).toHaveBeenCalledTimes(2)
  })

  it('título igual ao do roteiro não grava; plano sumido ou IPC fora → false, sem lançar', async () => {
    const same = deps()
    await expect(syncRoteiroTitle(ref, PLANNING_UNTITLED, same.d)).resolves.toBe(true)
    expect(same.api.planningSaveRoteiro).not.toHaveBeenCalled()

    const gone = deps()
    gone.api.planningOpen.mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'x' } as never)
    await expect(syncRoteiroTitle(ref, 'Checkout', gone.d)).resolves.toBe(false)

    const broken = deps()
    broken.api.planningOpen.mockRejectedValueOnce(new Error('canal fechado'))
    await expect(syncRoteiroTitle(ref, 'Checkout', broken.d)).resolves.toBe(false)
  })

  it('fecha a vigia que o planningOpen abriu — só se a tela desse plano NÃO estiver aberta', async () => {
    const off = deps(false)
    await syncRoteiroTitle(ref, 'Checkout', off.d)
    await vi.waitFor(() => expect(off.api.planningClose).toHaveBeenCalledWith(ref))

    const on = deps(true)
    await syncRoteiroTitle(ref, 'Checkout', on.d)
    await new Promise((r) => setTimeout(r, 0))
    expect(on.api.planningClose).not.toHaveBeenCalled()
  })

  it('duas trocas seguidas no mesmo plano gravam em ordem: a última fica', async () => {
    const { api, d } = deps()
    let disk = roteiro()
    api.planningOpen.mockImplementation(async () => ({
      ok: true as const,
      plan: { slug: ref.slug, roteiro: disk, cards: [], layout: { positions: {} }, invalid: [] }
    }))
    api.planningSaveRoteiro.mockImplementation(async (req) => {
      await new Promise((r) => setTimeout(r, 5))
      const saved = { ...req.roteiro, rev: req.expectedRev + 1 }
      disk = saved
      return { ok: true as const, roteiro: saved }
    })
    const first = syncRoteiroTitle(ref, 'Nome do LLM', d)
    const second = syncRoteiroTitle(ref, 'Nome do usuário', d)
    await Promise.all([first, second])
    expect(disk.titulo).toBe('Nome do usuário')
    expect(api.planningSaveRoteiro.mock.calls.map((c) => c[0].expectedRev)).toEqual([3, 4])
  })
})
