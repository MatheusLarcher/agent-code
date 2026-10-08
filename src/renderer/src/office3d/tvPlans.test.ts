import { describe, expect, it, vi } from 'vitest'
import { deriveOfficeModel, principalKey } from '../office/adapter/model'
import { conv, feed } from '../office/adapter/testFeed'
import { demoFeed } from './demoFeed'
import { DEMO_PLAN_ID, demoPlanPeek } from './demoPlan'
import { DEMO_LOOP_MS } from './demoTimeline'
import { PEEK_MS, planPeeksFor, roteiroOfPeek, TvPlans } from './tvPlans'

const NOW = 1_800_000_000_000
const plan = (id: string, cwd: string, slug: string, updatedAt: number) => conv(id, { cwd, mode: 'planning', planningSlug: slug, updatedAt })
const all = new Set(['conv:p1', 'conv:p2', 'conv:p3'])
const yes = (): boolean => true

describe('os planos na TV (TvPlans)', () => {
  it('a TV mostra o escolhido; senão o da conversa ativa; senão o mais recente; sempre dentro do filtro', () => {
    const t = new TvPlans(null, () => {})
    t.feed(feed({ conversations: [plan('p1', 'C:\\a', 's1', NOW - 3000), plan('p2', 'C:\\b', 's2', NOW - 1000), plan('p3', 'C:\\a', 's3', NOW - 2000), conv('x')], activeId: 'x' }), all)
    expect(t.current(yes)?.convId).toBe('p2')
    expect(t.all(yes).map((p) => p.convId)).toEqual(['p2', 'p3', 'p1'])
    t.feed(feed({ conversations: [plan('p1', 'C:\\a', 's1', NOW - 3000), plan('p2', 'C:\\b', 's2', NOW - 1000)], activeId: 'p1' }), all)
    expect(t.current(yes)?.convId).toBe('p1')
    t.prefer = 'p2'
    expect(t.current(yes)?.convId).toBe('p2')
    // Filtro no projeto a: o escolhido (de b) fica de fora.
    expect(t.current((id) => id === 'p1')?.convId).toBe('p1')
    // Quem não está no escritório não conta.
    t.feed(feed({ conversations: [plan('p1', 'C:\\a', 's1', NOW)] }), new Set())
    expect(t.current(yes)).toBeNull()
  })

  it('o resumo vem do main (sem vigia), uma leitura por vez; relê quando o plano muda ou a cada PEEK_MS', async () => {
    let now = NOW
    let changed: ((m: { projectCwd: string; slug: string }) => void) | null = null
    const peek = vi.fn(async () => ({ ok: true as const, plan: { titulo: 'Checkout', etapas: [{ titulo: 'Cenário', status: 'concluida' as const }], cards: 7, ambiguidadesAbertas: 2 } }))
    const ready = vi.fn()
    const t = new TvPlans({ planningPeek: peek, onPlanningChanged: (cb) => ((changed = cb), () => {}) }, ready, () => now)
    const p = { convId: 'p1', cwd: 'C:\\a', slug: 's1', title: 'Plano' }
    expect(t.peek(p)).toBeNull()
    expect(t.peek(p)).toBeNull()
    expect(peek).toHaveBeenCalledTimes(1)
    expect(peek).toHaveBeenCalledWith({ projectCwd: 'C:\\a', slug: 's1' })
    await Promise.resolve()
    await Promise.resolve()
    expect(ready).toHaveBeenCalled()
    expect(t.peek(p)).toMatchObject({ titulo: 'Checkout', cards: 7, ambiguidadesAbertas: 2 })
    expect(peek).toHaveBeenCalledTimes(1)
    changed!({ projectCwd: 'c:\\A', slug: 's1' })
    t.peek(p)
    expect(peek).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    await Promise.resolve()
    now += PEEK_MS
    t.peek(p)
    expect(peek).toHaveBeenCalledTimes(3)
    t.dispose()
  })

  it('o cache é um por ponte: a TV e as telas (planPeeksFor) pedem o resumo uma vez; o aviso de mudança relê e avisa quem assina', async () => {
    let changed: ((m: { projectCwd: string; slug: string }) => void) | null = null
    const peek = vi.fn(async () => ({ ok: true as const, plan: { titulo: 'Checkout', etapas: [{ id: 'banco', titulo: 'Banco', status: 'concluida' as const }], cards: 1, ambiguidadesAbertas: 0 } }))
    const api = { planningPeek: peek, onPlanningChanged: (cb: typeof changed) => ((changed = cb), () => {}) }
    const tv = new TvPlans(api, () => {}, () => NOW)
    const ref = { cwd: 'C:\\a', slug: 's1' }
    const cache = planPeeksFor(api)!
    expect(planPeeksFor(api)).toBe(cache)
    expect(planPeeksFor(null)).toBeNull()
    expect(planPeeksFor({})).toBeNull()
    tv.peek({ convId: 'p1', title: 'Plano', ...ref })
    expect(cache.get(ref)).toBeNull()
    expect(peek).toHaveBeenCalledTimes(1)
    const seen = vi.fn()
    const off = cache.subscribe(seen)
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(roteiroOfPeek(cache.cached(ref))).toEqual([{ id: 'banco', titulo: 'Banco' }])
    changed!({ projectCwd: 'c:\\A', slug: 's1' })
    expect(seen).toHaveBeenCalledTimes(2)
    cache.get(ref)
    expect(peek).toHaveBeenCalledTimes(2)
    off()
    tv.dispose()
  })

  it('o roteiro do resumo: as etapas com id, na ordem; sem o id de alguma (a demo), null', () => {
    const dto = (etapas: { id?: string; titulo: string }[]) => ({ titulo: 'x', cards: 0, ambiguidadesAbertas: 0, etapas: etapas.map((e) => ({ ...e, status: 'pendente' as const })) })
    expect(roteiroOfPeek(dto([{ id: 'a', titulo: 'A' }, { id: 'b', titulo: 'B' }]))).toEqual([{ id: 'a', titulo: 'A' }, { id: 'b', titulo: 'B' }])
    expect(roteiroOfPeek(dto([{ id: 'a', titulo: 'A' }, { titulo: 'B' }]))).toBeNull()
    expect(roteiroOfPeek(null)).toBeNull()
  })

  it('na demo o Manager do checkout está à cabeceira e a TV tem o resumo falso dele, sem pedir ao main', () => {
    const fd = demoFeed(10_000)
    const manager = deriveOfficeModel(fd, 10_000).characters.find((c) => c.convId === DEMO_PLAN_ID)
    expect(manager?.placement).toEqual({ kind: 'destination', papel: 'reuniao-cabeceira' })
    const peek = vi.fn()
    const t = new TvPlans({ planningPeek: peek }, () => {}, () => 10_000)
    t.demo = true
    t.feed(fd, new Set([principalKey(DEMO_PLAN_ID)]))
    const p = t.current(yes)!
    expect(p.convId).toBe(DEMO_PLAN_ID)
    expect(t.peek(p)).toMatchObject({ titulo: 'Checkout com Pix', etapas: [{ status: 'em_andamento' }, { status: 'pendente' }, { status: 'pendente' }, { status: 'pendente' }] })
    expect(demoPlanPeek(DEMO_LOOP_MS - 1).etapas.map((e) => e.status)).toEqual(['concluida', 'concluida', 'concluida', 'em_andamento'])
    expect(peek).not.toHaveBeenCalled()
  })
})
