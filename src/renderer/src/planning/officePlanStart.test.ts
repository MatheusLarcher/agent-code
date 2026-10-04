import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../types'
import { planProjectsOf, startOfficePlan } from './officePlanStart'

const conv = (id: string, cwd: string, extra: Partial<Conversation> = {}): Conversation => ({ id, cwd, title: id, messages: [] }) as unknown as Conversation & typeof extra

describe('planejar pelo Escritório (startOfficePlan)', () => {
  it('cria o plano no main ("Sem nome", slug livre), a conversa de planejamento e manda o pedido como 1ª mensagem', async () => {
    const api = { planningList: vi.fn(async () => ({ ok: true as const, slugs: ['plano-x'] })), planningCreate: vi.fn(async (_req: { projectCwd: string; slug: string; titulo: string }) => ({ ok: true as const })) }
    const made = conv('cp', 'C:\\loja')
    const create = vi.fn(() => made)
    const send = vi.fn()
    const notify = vi.fn()
    expect(await startOfficePlan('C:\\loja', '  checkout com Pix  ', { api, create, send, notify })).toBe('cp')
    const req = api.planningCreate.mock.calls[0][0]
    expect(req).toMatchObject({ projectCwd: 'C:\\loja', titulo: 'Sem nome' })
    expect(req.slug).toMatch(/^plano-\d{8}-\d{4}/)
    expect(create).toHaveBeenCalledWith(req.slug, 'Sem nome')
    expect(send).toHaveBeenCalledWith(made, 'checkout com Pix')
    expect(notify).not.toHaveBeenCalled()
  })

  it('sem pedido não manda mensagem; falha no main vira aviso e null', async () => {
    const send = vi.fn()
    const ok = { planningList: async () => ({ ok: true as const, slugs: [] }), planningCreate: async () => ({ ok: true as const }) }
    expect(await startOfficePlan('C:\\a', '', { api: ok, create: () => conv('c', 'C:\\a'), send, notify: vi.fn() })).toBe('c')
    expect(send).not.toHaveBeenCalled()
    const notify = vi.fn()
    const bad = { planningList: async () => ({ ok: true as const, slugs: [] }), planningCreate: async () => ({ ok: false as const, code: 'invalid' as const, message: 'pasta inválida' }) }
    expect(await startOfficePlan('C:\\a', 'x', { api: bad, create: vi.fn(), send, notify })).toBeNull()
    expect(notify).toHaveBeenCalledWith('erro', 'Não consegui criar o planejamento: pasta inválida')
  })

  it('planProjectsOf: as pastas das conversas, sem repetir e sem a Central, pelo nome', () => {
    const list = planProjectsOf([conv('a', 'C:\\x\\loja'), conv('b', 'C:\\x\\loja'), conv('c', 'C:\\x\\api'), conv('central', ''), { ...conv('central', 'C:\\x'), mode: 'central' } as Conversation])
    expect(list).toEqual([
      { cwd: 'C:\\x\\api', name: 'api' },
      { cwd: 'C:\\x\\loja', name: 'loja' }
    ])
    // As pastas do sandbox ficam de fora (como no "Novo planejamento" da barra lateral).
    expect(planProjectsOf([conv('a', 'C:\\x\\loja'), conv('s', 'C:\\sbx\\2026-10-04_18-55_9e68')], 'C:\\sbx')).toEqual([{ cwd: 'C:\\x\\loja', name: 'loja' }])
  })
})
