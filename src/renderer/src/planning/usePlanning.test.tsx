import { describe, it, expect, afterEach } from 'vitest'
import { act, cleanup, renderHook, screen, waitFor } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import {
  CONFLICT_MSG,
  ESTIMATIVA_INVALIDA_MSG,
  ROTEIRO_CONFLICT_MSG,
  isSamePlan,
  nextStageStatus,
  usePlanning
} from './usePlanning'
import { CWD, SLUG, makeCard, makePlan, mockPlanningApi } from './planningTestUtils'

afterEach(cleanup)

function setup(slug = SLUG) {
  return renderHook((props: { slug: string }) => usePlanning(CWD, props.slug), {
    wrapper: UiProvider,
    initialProps: { slug }
  })
}

describe('usePlanning — abrir e fechar', () => {
  it('carrega via planningOpen e fecha com planningClose no unmount', async () => {
    const { api } = mockPlanningApi()
    const { result, unmount } = setup()
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(api.planningOpen).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG })
    expect(result.current.plan?.roteiro.titulo).toBe('Plano de teste')
    unmount()
    expect(api.planningClose).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG })
  })

  it('trocar de slug fecha o plano anterior e abre o novo', async () => {
    const { api } = mockPlanningApi()
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    rerender({ slug: 'outro' })
    expect(api.planningClose).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG })
    await waitFor(() => expect(api.planningOpen).toHaveBeenLastCalledWith({ projectCwd: CWD, slug: 'outro' }))
  })

  it('falha ao abrir vira status de erro com o motivo', async () => {
    const { api } = mockPlanningApi()
    api.planningOpen.mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'plano não existe' } as never)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('plano não existe')
    expect(result.current.plan).toBeNull()
  })
})

describe('usePlanning — planning:changed', () => {
  it('recarrega no evento do mesmo plano e ignora o de outro', async () => {
    const mock = mockPlanningApi()
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(mock.api.planningOpen).toHaveBeenCalledTimes(1)

    act(() => mock.emitChanged({ projectCwd: CWD, slug: 'outro-plano' }))
    act(() => mock.emitChanged({ projectCwd: 'C:\\outro\\projeto', slug: SLUG }))
    expect(mock.api.planningOpen).toHaveBeenCalledTimes(1)

    mock.setPlan(makePlan({ cards: [makeCard('novo', { titulo: 'Criado pelo agente' })] }))
    // Mesmo plano com barra e caixa diferentes: ainda é o mesmo.
    act(() => mock.emitChanged({ projectCwd: 'c:/proj/app/', slug: SLUG }))
    await waitFor(() => expect(result.current.plan?.cards.map((c) => c.id)).toEqual(['novo']))
    expect(mock.api.planningOpen).toHaveBeenCalledTimes(2)
  })

  it('para de ouvir o evento depois do unmount', async () => {
    const mock = mockPlanningApi()
    const { result, unmount } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    unmount()
    expect(mock.listenerCount()).toBe(0)
  })

  it('isSamePlan compara caminho sem ligar para barra, caixa ou barra final', () => {
    expect(isSamePlan({ projectCwd: 'C:\\A\\b\\', slug: 'x' }, 'c:/a/b', 'x')).toBe(true)
    expect(isSamePlan({ projectCwd: 'C:\\A\\b', slug: 'y' }, 'c:/a/b', 'x')).toBe(false)
    expect(isSamePlan({ projectCwd: 'C:\\A\\c', slug: 'x' }, 'c:/a/b', 'x')).toBe(false)
  })
})

describe('usePlanning — gravações', () => {
  it('saveCard manda o expectedRev e atualiza o card com o rev novo', async () => {
    const { api } = mockPlanningApi()
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const card = result.current.plan!.cards[0]
    let out: Awaited<ReturnType<typeof result.current.saveCard>> | undefined
    await act(async () => {
      out = await result.current.saveCard({ ...card, titulo: 'Login revisto' }, card.rev)
    })
    expect(api.planningSaveCard).toHaveBeenCalledWith(
      expect.objectContaining({ projectCwd: CWD, slug: SLUG, expectedRev: 4, card: expect.objectContaining({ id: 'login' }) })
    )
    expect(out).toMatchObject({ ok: true })
    expect(result.current.plan!.cards[0]).toMatchObject({ titulo: 'Login revisto', rev: 5 })
  })

  it('rev_conflict avisa com toast "aviso" e recarrega a versão atual', async () => {
    const mock = mockPlanningApi()
    const current = makeCard('login', { titulo: 'Versão do agente', rev: 7, etapa: 'requisitos' })
    mock.api.planningSaveCard.mockResolvedValueOnce({ ok: false, code: 'rev_conflict', current } as never)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    mock.setPlan(makePlan({ cards: [current] }))

    let out: Awaited<ReturnType<typeof result.current.saveCard>> | undefined
    await act(async () => {
      out = await result.current.saveCard({ ...result.current.plan!.cards[0], titulo: 'Minha versão' }, 4)
    })
    expect(out).toEqual({ ok: false, conflict: true, current })
    const toast = await screen.findByText(CONFLICT_MSG)
    expect(toast.closest('.toast')?.classList.contains('aviso')).toBe(true)
    await waitFor(() => expect(result.current.plan!.cards[0]).toMatchObject({ titulo: 'Versão do agente', rev: 7 }))
    expect(mock.api.planningOpen).toHaveBeenCalledTimes(2)
  })

  it('quietConflict: no rev_conflict recarrega sem toast (quem chamou avisa)', async () => {
    const mock = mockPlanningApi()
    const current = makeCard('login', { titulo: 'Versão do agente', rev: 7, etapa: 'requisitos' })
    mock.api.planningSaveCard.mockResolvedValueOnce({ ok: false, code: 'rev_conflict', current } as never)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    mock.setPlan(makePlan({ cards: [current] }))
    let out: Awaited<ReturnType<typeof result.current.saveCard>> | undefined
    await act(async () => {
      out = await result.current.saveCard({ ...result.current.plan!.cards[0], titulo: 'Minha' }, 4, { quietConflict: true })
    })
    expect(out).toEqual({ ok: false, conflict: true, current })
    await waitFor(() => expect(result.current.plan!.cards[0]).toMatchObject({ titulo: 'Versão do agente', rev: 7 }))
    expect(screen.queryByText(CONFLICT_MSG)).toBeNull()
  })

  it('outra falha vira toast de erro com a mensagem', async () => {
    const mock = mockPlanningApi()
    mock.api.planningDeleteCard.mockResolvedValueOnce({ ok: false, code: 'io', message: 'disco cheio' } as never)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let ok = true
    await act(async () => {
      ok = await result.current.deleteCard('login', 4)
    })
    expect(ok).toBe(false)
    const toast = await screen.findByText(/disco cheio/)
    expect(toast.closest('.toast')?.classList.contains('erro')).toBe(true)
    expect(result.current.plan!.cards.map((c) => c.id)).toContain('login')
  })

  it('IPC que rejeita não lança: vira toast de erro', async () => {
    const mock = mockPlanningApi()
    mock.api.planningSaveCard.mockRejectedValueOnce(new Error('canal fechado'))
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      await result.current.saveCard(result.current.plan!.cards[0], 4)
    })
    expect(await screen.findByText(/canal fechado/)).toBeTruthy()
  })

  it('deleteCard tira o card do plano quando o disco confirma', async () => {
    const { api } = mockPlanningApi()
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      await result.current.deleteCard('banco', 2)
    })
    expect(api.planningDeleteCard).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG, id: 'banco', expectedRev: 2 })
    expect(result.current.plan!.cards.map((c) => c.id)).toEqual(['login'])
  })

  it('saveLayout é otimista e grava UMA vez depois do debounce', async () => {
    const { api } = mockPlanningApi()
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => {
      result.current.saveLayout({ login: { x: 10.4, y: 20.6 } })
      result.current.saveLayout({ login: { x: 30, y: 40 } })
      result.current.saveLayout({ banco: { x: 500, y: 90 } })
    })
    expect(result.current.plan!.layout.positions.login).toEqual({ x: 30, y: 40 })
    expect(api.planningSaveLayout).not.toHaveBeenCalled()
    await waitFor(() => expect(api.planningSaveLayout).toHaveBeenCalledTimes(1))
    expect(api.planningSaveLayout).toHaveBeenCalledWith({
      projectCwd: CWD,
      slug: SLUG,
      layout: { positions: { login: { x: 30, y: 40 }, banco: { x: 500, y: 90 } } }
    })
  })

  it('saveViewport grava o pan/zoom junto das posições, no mesmo debounce', async () => {
    const { api } = mockPlanningApi(makePlan({ layout: { positions: { login: { x: 5, y: 6 } } } }))
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => {
      result.current.saveViewport({ x: 10.6, y: -20.2, zoom: 0.92345 })
      result.current.saveViewport({ x: Number.NaN, y: 0, zoom: 1 }) // inválido: ignorado
    })
    expect(api.planningSaveLayout).not.toHaveBeenCalled()
    await waitFor(() => expect(api.planningSaveLayout).toHaveBeenCalledTimes(1))
    expect(api.planningSaveLayout).toHaveBeenCalledWith({
      projectCwd: CWD,
      slug: SLUG,
      layout: { positions: { login: { x: 5, y: 6 } }, viewport: { x: 11, y: -20, zoom: 0.923 } }
    })
  })

  it('gravar posição mantém o viewport que veio do disco', async () => {
    const viewport = { x: 1, y: 2, zoom: 1.1 }
    const { api } = mockPlanningApi(makePlan({ layout: { positions: {}, viewport } }))
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.saveLayout({ login: { x: 30, y: 40 } }))
    await waitFor(() => expect(api.planningSaveLayout).toHaveBeenCalledTimes(1))
    expect(api.planningSaveLayout).toHaveBeenCalledWith({
      projectCwd: CWD,
      slug: SLUG,
      layout: { positions: { login: { x: 30, y: 40 } }, viewport }
    })
  })

  it('unmount grava na hora a posição que ainda estava no debounce', async () => {
    const { api } = mockPlanningApi()
    const { result, unmount } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.saveLayout({ login: { x: 1, y: 2 } }))
    unmount()
    expect(api.planningSaveLayout).toHaveBeenCalledTimes(1)
  })

  it('toggleEtapa avança o status e grava o roteiro inteiro', async () => {
    const { api } = mockPlanningApi()
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      await result.current.toggleEtapa('desenho')
    })
    const sent = (api.planningSaveRoteiro.mock.calls[0] as unknown as [{ roteiro: { etapas: { id: string; status: string }[] } }])[0]
    expect(sent.roteiro.etapas.map((e) => `${e.id}:${e.status}`)).toEqual([
      'requisitos:concluida',
      'desenho:em_andamento',
      'entrega:em_andamento'
    ])
    expect(result.current.plan!.roteiro.etapas[1].status).toBe('em_andamento')
  })

  it('toggleEtapa regrava o roteiro com a estimativa de cada etapa (cleanRoteiro não a descarta)', async () => {
    const plan = makePlan()
    plan.roteiro.etapas = plan.roteiro.etapas.map((e) => (e.id === 'entrega' ? e : { ...e, estimativa: e.id === 'desenho' ? 90 : 30 }))
    const { api } = mockPlanningApi(plan)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      await result.current.toggleEtapa('desenho')
    })
    const sent = (api.planningSaveRoteiro.mock.calls[0] as unknown as [{ roteiro: { etapas: object[] } }])[0]
    expect(sent.roteiro.etapas).toEqual([
      { id: 'requisitos', titulo: 'Levantar requisitos', status: 'concluida', estimativa: 30 },
      { id: 'desenho', titulo: 'Desenhar a solução', status: 'em_andamento', estimativa: 90 },
      { id: 'entrega', titulo: 'Entregar', status: 'em_andamento' } // sem estimativa: sem a chave
    ])
    expect('estimativa' in sent.roteiro.etapas[2]).toBe(false)
  })
})

type SaveRoteiroReq = { roteiro: { rev?: number; etapas: { id: string; status: string }[] }; expectedRev: number }
const sentAt = (api: ReturnType<typeof mockPlanningApi>['api'], i: number): SaveRoteiroReq =>
  (api.planningSaveRoteiro.mock.calls[i] as unknown as [SaveRoteiroReq])[0]
const stages = (r: { etapas: { id: string; status: string }[] }): string[] => r.etapas.map((e) => `${e.id}:${e.status}`)

describe('usePlanning — rev do roteiro', () => {
  it('toggleEtapa manda o expectedRev do roteiro carregado e guarda o rev novo', async () => {
    const { api } = mockPlanningApi() // roteiro em rev 3
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      expect(await result.current.toggleEtapa('desenho')).toBe(true)
    })
    expect(sentAt(api, 0)).toMatchObject({ projectCwd: CWD, slug: SLUG, expectedRev: 3 })
    expect(sentAt(api, 0).roteiro).not.toHaveProperty('rev') // o rev vai só em expectedRev
    expect(result.current.plan!.roteiro.rev).toBe(4)
    await act(async () => {
      await result.current.toggleEtapa('desenho')
    })
    expect(sentAt(api, 1).expectedRev).toBe(4)
  })

  it('roteiro sem rev (gravado antes dele) manda expectedRev 0', async () => {
    const plan = makePlan()
    delete plan.roteiro.rev
    const { api } = mockPlanningApi(plan)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => {
      await result.current.toggleEtapa('desenho')
    })
    expect(sentAt(api, 0).expectedRev).toBe(0)
    expect(result.current.plan!.roteiro.rev).toBe(1)
  })

  it('roteiro_conflict: reaplica UMA vez sobre o roteiro atual, sem toast e sem perder a mudança do outro', async () => {
    const mock = mockPlanningApi()
    const agente = { ...makePlan().roteiro, rev: 5 }
    agente.etapas = agente.etapas.map((e) => (e.id === 'entrega' ? { ...e, status: 'concluida' as const } : e))
    mock.api.planningSaveRoteiro.mockResolvedValueOnce({
      ok: false,
      code: 'roteiro_conflict',
      message: 'rev do roteiro desatualizado: esperado 3, atual 5',
      current: agente
    } as never)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let ok = false
    await act(async () => {
      ok = await result.current.toggleEtapa('desenho')
    })
    expect(ok).toBe(true)
    expect(mock.api.planningSaveRoteiro).toHaveBeenCalledTimes(2)
    expect(sentAt(mock.api, 1).expectedRev).toBe(5)
    expect(stages(sentAt(mock.api, 1).roteiro)).toEqual(['requisitos:concluida', 'desenho:em_andamento', 'entrega:concluida'])
    expect(result.current.plan!.roteiro.rev).toBe(6)
    expect(stages(result.current.plan!.roteiro)).toEqual(['requisitos:concluida', 'desenho:em_andamento', 'entrega:concluida'])
    expect(screen.queryByText(ROTEIRO_CONFLICT_MSG)).toBeNull()
    expect(mock.api.planningOpen).toHaveBeenCalledTimes(1)
  })

  it('roteiro_conflict sem a etapa no roteiro atual: não regrava, toast "aviso" e recarrega', async () => {
    const mock = mockPlanningApi()
    const semDesenho = { ...makePlan().roteiro, rev: 5 }
    semDesenho.etapas = semDesenho.etapas.filter((e) => e.id !== 'desenho')
    mock.api.planningSaveRoteiro.mockResolvedValueOnce({
      ok: false,
      code: 'roteiro_conflict',
      message: 'x',
      current: semDesenho
    } as never)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    mock.setPlan(makePlan({ roteiro: semDesenho }))
    let ok = true
    await act(async () => {
      ok = await result.current.toggleEtapa('desenho')
    })
    expect(ok).toBe(false)
    expect(mock.api.planningSaveRoteiro).toHaveBeenCalledTimes(1)
    const toast = await screen.findByText(ROTEIRO_CONFLICT_MSG)
    expect(toast.closest('.toast')?.classList.contains('aviso')).toBe(true)
    await waitFor(() => expect(mock.api.planningOpen).toHaveBeenCalledTimes(2))
    expect(stages(result.current.plan!.roteiro)).toEqual(['requisitos:concluida', 'entrega:em_andamento'])
  })

  it('conflito também na segunda tentativa: não tenta a terceira; toast "aviso" e recarrega', async () => {
    const mock = mockPlanningApi()
    const conflict = (rev: number) =>
      ({ ok: false, code: 'roteiro_conflict', message: 'x', current: { ...makePlan().roteiro, rev } }) as never
    mock.api.planningSaveRoteiro.mockResolvedValueOnce(conflict(5)).mockResolvedValueOnce(conflict(6))
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let ok = true
    await act(async () => {
      ok = await result.current.toggleEtapa('desenho')
    })
    expect(ok).toBe(false)
    expect(mock.api.planningSaveRoteiro).toHaveBeenCalledTimes(2)
    expect(await screen.findByText(ROTEIRO_CONFLICT_MSG)).toBeTruthy()
    await waitFor(() => expect(mock.api.planningOpen).toHaveBeenCalledTimes(2))
    expect(result.current.plan!.roteiro.etapas.find((e) => e.id === 'desenho')?.status).toBe('pendente')
  })

  it('roteiro_conflict em que o outro já deixou a etapa como o usuário queria: nada a regravar', async () => {
    const mock = mockPlanningApi()
    const igual = { ...makePlan().roteiro, rev: 5 }
    igual.etapas = igual.etapas.map((e) => (e.id === 'desenho' ? { ...e, status: 'em_andamento' as const } : e))
    mock.api.planningSaveRoteiro.mockResolvedValueOnce({ ok: false, code: 'roteiro_conflict', message: 'x', current: igual } as never)
    const { result } = setup()
    await waitFor(() => expect(result.current.status).toBe('ready'))
    let ok = false
    await act(async () => {
      ok = await result.current.toggleEtapa('desenho')
    })
    expect(ok).toBe(true)
    expect(mock.api.planningSaveRoteiro).toHaveBeenCalledTimes(1)
    expect(result.current.plan!.roteiro).toEqual(igual)
  })
})

describe('usePlanning — estimativa da etapa (setEstimativa)', () => {
  type Est = { id: string; estimativa?: number }
  const ests = (r: { etapas: Est[] }): string[] => r.etapas.map((e) => `${e.id}:${e.estimativa ?? '—'}`)
  const sentEst = (api: ReturnType<typeof mockPlanningApi>['api'], i: number) =>
    (api.planningSaveRoteiro.mock.calls[i] as unknown as [{ roteiro: { etapas: Est[] }; expectedRev: number }])[0]
  const withEst = (rev: number, desenho?: number, entrega?: number) => {
    const r = { ...makePlan().roteiro, rev }
    r.etapas = r.etapas.map((e) => {
      const v = e.id === 'desenho' ? desenho : e.id === 'entrega' ? entrega : undefined
      return v === undefined ? e : { ...e, estimativa: v }
    })
    return r
  }
  async function ready(roteiro = withEst(3)) {
    const mock = mockPlanningApi(makePlan({ roteiro }))
    const hook = setup()
    await waitFor(() => expect(hook.result.current.status).toBe('ready'))
    const set = async (id: string, v: number | null): Promise<boolean> => {
      let ok = false
      await act(async () => {
        ok = await hook.result.current.setEstimativa(id, v)
      })
      return ok
    }
    return { ...mock, result: hook.result, set }
  }

  it('grava com o expectedRev carregado, guarda o rev novo; null tira a chave', async () => {
    const { api, result, set } = await ready(withEst(3, 90))
    expect(await set('entrega', 45)).toBe(true)
    expect(sentEst(api, 0).expectedRev).toBe(3)
    expect(ests(sentEst(api, 0).roteiro)).toEqual(['requisitos:—', 'desenho:90', 'entrega:45'])
    expect(result.current.plan!.roteiro.rev).toBe(4)
    expect(await set('desenho', null)).toBe(true)
    expect(sentEst(api, 1).expectedRev).toBe(4)
    expect('estimativa' in sentEst(api, 1).roteiro.etapas[1]).toBe(false)
    expect(ests(result.current.plan!.roteiro)).toEqual(['requisitos:—', 'desenho:—', 'entrega:45'])
    expect(await set('entrega', 45)).toBe(true) // igual ao atual: nada a gravar
    expect(api.planningSaveRoteiro).toHaveBeenCalledTimes(2)
  })

  it('fora de 1..10000 ou não inteiro: não grava, toast "aviso"', async () => {
    const { api, set } = await ready()
    for (const v of [0, 10_001, 1.5, Number.NaN]) expect(await set('desenho', v)).toBe(false)
    expect(api.planningSaveRoteiro).not.toHaveBeenCalled()
    const toasts = await screen.findAllByText(ESTIMATIVA_INVALIDA_MSG)
    expect(toasts[0].closest('.toast')?.classList.contains('aviso')).toBe(true)
  })

  it('roteiro_conflict: reaplica UMA vez sobre o atual, sem perder a mudança do outro', async () => {
    const { api, result, set } = await ready()
    api.planningSaveRoteiro.mockResolvedValueOnce({ ok: false, code: 'roteiro_conflict', message: 'x', current: withEst(5, undefined, 20) } as never)
    expect(await set('desenho', 60)).toBe(true)
    expect(api.planningSaveRoteiro).toHaveBeenCalledTimes(2)
    expect(sentEst(api, 1).expectedRev).toBe(5)
    expect(ests(sentEst(api, 1).roteiro)).toEqual(['requisitos:—', 'desenho:60', 'entrega:20'])
    expect(result.current.plan!.roteiro.rev).toBe(6)
    expect(screen.queryByText(ROTEIRO_CONFLICT_MSG)).toBeNull()
  })

  it('conflito também na segunda: desfaz, toast "aviso" e recarrega', async () => {
    const { api, result, set } = await ready()
    const conflict = (rev: number) => ({ ok: false, code: 'roteiro_conflict', message: 'x', current: withEst(rev) }) as never
    api.planningSaveRoteiro.mockResolvedValueOnce(conflict(5)).mockResolvedValueOnce(conflict(6))
    expect(await set('desenho', 60)).toBe(false)
    expect(api.planningSaveRoteiro).toHaveBeenCalledTimes(2)
    expect((await screen.findByText(ROTEIRO_CONFLICT_MSG)).closest('.toast')?.classList.contains('aviso')).toBe(true)
    await waitFor(() => expect(api.planningOpen).toHaveBeenCalledTimes(2))
    expect(ests(result.current.plan!.roteiro)).toEqual(['requisitos:—', 'desenho:—', 'entrega:—'])
  })

  it('o outro já gravou a mesma estimativa: nada a regravar', async () => {
    const { api, result, set } = await ready()
    api.planningSaveRoteiro.mockResolvedValueOnce({ ok: false, code: 'roteiro_conflict', message: 'x', current: withEst(5, 60) } as never)
    expect(await set('desenho', 60)).toBe(true)
    expect(api.planningSaveRoteiro).toHaveBeenCalledTimes(1)
    expect(result.current.plan!.roteiro.rev).toBe(5)
  })

  it('falha de gravação: toast "erro" com o motivo e recarrega (desfaz)', async () => {
    const { api, result, set } = await ready()
    api.planningSaveRoteiro.mockResolvedValueOnce({ ok: false, code: 'io', message: 'disco cheio' } as never)
    expect(await set('desenho', 60)).toBe(false)
    const toast = await screen.findByText('Não consegui salvar a estimativa da etapa: disco cheio')
    expect(toast.closest('.toast')?.classList.contains('erro')).toBe(true)
    await waitFor(() => expect(ests(result.current.plan!.roteiro)).toEqual(['requisitos:—', 'desenho:—', 'entrega:—']))
  })
})

describe('usePlanning — ciclo de status', () => {

  it('nextStageStatus cicla pendente → em_andamento → concluida → pendente', () => {
    expect(nextStageStatus('pendente')).toBe('em_andamento')
    expect(nextStageStatus('em_andamento')).toBe('concluida')
    expect(nextStageStatus('concluida')).toBe('pendente')
  })
})
