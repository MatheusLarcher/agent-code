/** Rotas da aba Planos: tradução dos erros da ponte (PC antigo, recusa, rede), respostas e o aviso do SSE. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { client } from '../app/runtime'
import { HttpError } from './net'
import { createPlan, getPlan, listPlans, OLD_PC_TEXT, planMediaUrl, planningChange, toPlanningError } from './planning'

describe('core/planning', () => {
  afterEach(() => vi.restoreAllMocks())

  it('404 "rota desconhecida" = PC antigo; corpo {ok:false} = recusa com código; sem resposta = rede', () => {
    const old = toPlanningError(new HttpError(404, { error: 'rota desconhecida' }))
    expect(old.kind).toBe('old-pc')
    expect(old.message).toBe(OLD_PC_TEXT)
    const gone = toPlanningError(new HttpError(404, { ok: false, code: 'not_found', message: 'planejamento não encontrado: x' }))
    expect([gone.kind, gone.code, gone.message]).toEqual(['failure', 'not_found', 'planejamento não encontrado: x'])
    expect(toPlanningError(new HttpError(403, { ok: false, code: 'unknown_project', message: 'projeto desconhecido' })).code).toBe('unknown_project')
    expect(toPlanningError(new HttpError(0)).kind).toBe('net')
  })

  it('lista e plano: monta a query com cwd/slug codificados e devolve o conteúdo', async () => {
    const req = vi.spyOn(client, 'request').mockImplementation(async (path: string) => {
      if (path.startsWith('/api/planning/list')) return { ok: true, plans: [{ slug: 'a', titulo: 'A', etapas: { total: 1, concluidas: 0 }, cards: 0, ambiguidadesAbertas: 0 }] } as never
      return { ok: true, plan: { slug: 'a', roteiro: { titulo: 'A', etapas: [] }, cards: [] } } as never
    })
    expect((await listPlans(client, 'C:\\p x'))[0].slug).toBe('a')
    expect(req.mock.calls[0][0]).toBe('/api/planning/list?cwd=C%3A%5Cp%20x')
    const plan = await getPlan(client, 'C:\\p x', 'a')
    expect(req.mock.calls[1][0]).toBe('/api/planning/plan?cwd=C%3A%5Cp%20x&slug=a')
    expect(plan.media).toEqual([]) // campos ausentes viram listas vazias
    expect(plan.invalid).toEqual([])
  })

  it('erro da ponte sobe como PlanningError', async () => {
    vi.spyOn(client, 'request').mockRejectedValue(new HttpError(404, { error: 'rota desconhecida' }))
    await expect(listPlans(client, 'C:\\p')).rejects.toMatchObject({ kind: 'old-pc' })
  })

  it('criar: POST com cwd e pedido (sem pedido vazio) e devolve o convId', async () => {
    const post = vi.spyOn(client, 'post').mockResolvedValue({ ok: true, convId: 'c-1' } as never)
    expect(await createPlan(client, 'C:\\p', '  login  ')).toBe('c-1')
    expect(post).toHaveBeenCalledWith('/api/planning/create', { cwd: 'C:\\p', pedido: 'login' })
    await createPlan(client, 'C:\\p', '   ')
    expect(post).toHaveBeenLastCalledWith('/api/planning/create', { cwd: 'C:\\p' })
  })

  it('URL da mídia leva token e os parâmetros codificados', () => {
    client.store.set({ base: 'http://pc:8765', token: 'tk' })
    const url = planMediaUrl(client, 'C:\\p', 'plano', 'logo.png')
    expect(url).toContain('http://pc:8765/api/planning/media?cwd=C%3A%5Cp&slug=plano&name=logo.png')
    expect(url).toContain('token=tk')
  })

  it('planning-changed: só o envelope "planning" com projectCwd/slug de texto', () => {
    expect(planningChange({ convId: 'planning', event: { kind: 'planning-changed', projectCwd: 'C:\\p', slug: 's' } })).toEqual({ kind: 'planning-changed', projectCwd: 'C:\\p', slug: 's' })
    expect(planningChange({ convId: 'c1', event: { kind: 'planning-changed', projectCwd: 'C:\\p', slug: 's' } })).toBeNull()
    expect(planningChange({ convId: 'planning', event: { kind: 'planning-changed', projectCwd: 1, slug: 's' } })).toBeNull()
    expect(planningChange({ convId: 'planning', event: { kind: 'office-call' } })).toBeNull()
  })
})
