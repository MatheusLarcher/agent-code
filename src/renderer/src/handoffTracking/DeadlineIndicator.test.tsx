import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { HandoffChangedMsg, HandoffListRequest, HandoffListResult } from '@shared/api'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { DeadlineIndicator } from './DeadlineIndicator'
import { envio, entrega, MIN, running } from './handoffFixtures'

afterEach(cleanup)

/**
 * handoff:list e handoff:changed em memória, com o aviso disparável pelo teste.
 * Por conversa, só os envios dela; por projeto (os do plano), todos.
 */
function mockApi(initial: HandoffEnvio[]) {
  let next: HandoffListResult = { ok: true, envios: initial }
  const listeners = new Set<(msg: HandoffChangedMsg) => void>()
  const off = vi.fn()
  const api = {
    handoffList: vi.fn(async (req?: HandoffListRequest): Promise<HandoffListResult> => {
      const res = structuredClone(next)
      return res.ok && req?.conversationId ? { ok: true, envios: res.envios.filter((e) => e.conversationId === req.conversationId) } : res
    }),
    onHandoffChanged: vi.fn((cb: (msg: HandoffChangedMsg) => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
        off()
      }
    })
  }
  return {
    api,
    off,
    listeners,
    /** As leituras da conversa (as do plano, por projeto, ficam de fora). */
    convCalls: (): HandoffListRequest[] => api.handoffList.mock.calls.map(([req]) => req ?? {}).filter((req) => !!req.conversationId),
    set(envios: HandoffEnvio[]) {
      next = { ok: true, envios }
    },
    fail(message: string) {
      next = { ok: false, message }
    },
    changed(conversationId: string) {
      act(() => {
        for (const cb of listeners) cb({ conversationId })
      })
    }
  }
}

const indicator = (): HTMLElement | null => document.querySelector('.deadline-indicator')
const level = (): string | undefined => indicator()?.dataset.level

async function shown(): Promise<HTMLElement> {
  await waitFor(() => expect(indicator()).not.toBeNull())
  return indicator() as HTMLElement
}

describe('DeadlineIndicator', () => {
  it('lê do banco (handoff:list da conversa): etapa atual, tempo ativo/prazo e estimativa do agente', async () => {
    const m = mockApi([running(12 * MIN)])
    render(<DeadlineIndicator conversationId="conv-1" api={m.api} />)
    const el = await shown()
    expect(m.api.handoffList).toHaveBeenCalledWith({ conversationId: 'conv-1' })
    expect(screen.getByText('Etapa 1 de 2: Registro no banco')).toBeTruthy()
    expect(screen.getByText('12 de 30 min')).toBeTruthy()
    expect(screen.getByText('agente 20 min')).toBeTruthy()
    expect(el.className).toContain('is-ok')
    expect(el.title).toContain('Prazo (estimativa do plano): 30 min.')
    expect(el.title).toContain('Tempo ativo medido pelo app')
  })

  it('a cor muda ao chegar a 80% e ao passar de 100% do prazo, relendo a cada handoff:changed', async () => {
    const m = mockApi([running(23 * MIN)])
    render(<DeadlineIndicator conversationId="conv-1" api={m.api} />)
    await shown()
    expect(level()).toBe('ok')

    m.set([running(24 * MIN)])
    m.changed('conv-1')
    await waitFor(() => expect(level()).toBe('alerta'))
    expect(indicator()?.className).toContain('is-alerta')
    expect(screen.getByText('24 de 30 min')).toBeTruthy()

    m.set([running(30 * MIN + 1)])
    m.changed('conv-1')
    await waitFor(() => expect(level()).toBe('estourado'))
    expect(indicator()?.className).toContain('is-estourado')
    expect(screen.getByText('31 de 30 min')).toBeTruthy()
  })

  it('aviso de OUTRA conversa não relê a conversa (só os envios do plano); o desta relê com os valores novos do banco', async () => {
    const m = mockApi([running(5 * MIN)])
    render(<DeadlineIndicator conversationId="conv-1" api={m.api} />)
    await shown()
    expect(m.convCalls()).toHaveLength(1)
    m.set([running(6 * MIN, { estimativaAgente: 25 })])
    m.changed('conv-2')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(m.convCalls()).toHaveLength(1)
    expect(screen.getByText('5 de 30 min')).toBeTruthy()

    m.changed('conv-1')
    await waitFor(() => expect(screen.getByText('6 de 30 min')).toBeTruthy())
    expect(screen.getByText('agente 25 min')).toBeTruthy()
    expect(m.convCalls()).toHaveLength(2)
  })

  it('"Etapa N de M" pela posição no PLANO: os envios do plano no projeto (de outra conversa também) e o roteiro', async () => {
    const parte1 = envio({
      id: 'he-0', conversationId: 'conv-0', status: 'concluida', criadoEm: '2026-10-05T11:00:00.000Z', enviadoEm: '2026-10-05T11:00:00.000Z',
      entregas: [entrega({ etapaId: 'banco', etapaTitulo: 'Banco', status: 'concluida' }), entrega({ etapaId: 'tela', etapaTitulo: 'Tela', ordem: 2, status: 'concluida' })]
    })
    const parte2 = envio({ entregas: [entrega({ etapaId: 'pix', etapaTitulo: 'Pix', status: 'em_andamento', tempoAtivoMs: 4 * MIN })] })
    const m = mockApi([parte1, parte2])
    const { unmount } = render(<DeadlineIndicator conversationId="conv-1" api={m.api} peekApi={null} />)
    await waitFor(() => expect(screen.getByText('Etapa 3 de 3: Pix')).toBeTruthy())
    expect(m.api.handoffList).toHaveBeenCalledWith({ projectCwd: 'C:/proj', limit: 1000 })
    unmount()

    // O título vem do roteiro (o plano pode tê-lo renomeado depois do envio).
    const etapas = ['banco', 'tela', 'pix', 'aceite'].map((id) => ({ id, titulo: id === 'pix' ? 'Pix no checkout' : id, status: 'pendente' as const }))
    const peekApi = { planningPeek: vi.fn(async () => ({ ok: true as const, plan: { titulo: 'Checkout', etapas, cards: 0, ambiguidadesAbertas: 0 } })) }
    render(<DeadlineIndicator conversationId="conv-1" api={m.api} peekApi={peekApi} />)
    await waitFor(() => expect(screen.getByText('Etapa 3 de 4: Pix no checkout')).toBeTruthy())
    expect(peekApi.planningPeek).toHaveBeenCalledWith({ projectCwd: 'C:/proj', slug: 'checkout' })
  })

  it('sem envio registrado ou sem estimativa do plano: neutro e discreto ("sem prazo")', async () => {
    const m = mockApi([])
    render(<DeadlineIndicator conversationId="conv-1" api={m.api} />)
    await shown()
    expect(level()).toBe('neutro')
    expect(indicator()?.textContent).toBe('sem prazo')

    m.set([envio({ estimativaTotal: null, prazoTotal: null, entregas: [entrega({ status: 'em_andamento', estimativaPlano: null, tempoAtivoMs: 3 * MIN })] })])
    m.changed('conv-1')
    await waitFor(() => expect(screen.getByText('3 min · sem prazo')).toBeTruthy())
    expect(level()).toBe('neutro')
    expect(screen.getByText('agente: sem estimativa')).toBeTruthy()
  })

  it('leitura que falha: "prazo indisponível"; numa releitura que falha, fica o último dado', async () => {
    const m = mockApi([])
    m.fail('O banco está indisponível agora.')
    const { unmount } = render(<DeadlineIndicator conversationId="conv-1" api={m.api} />)
    await shown()
    expect(indicator()?.textContent).toBe('prazo indisponível')
    expect(indicator()?.title).toContain('O banco está indisponível agora.')
    unmount()

    const ok = mockApi([running(9 * MIN)])
    render(<DeadlineIndicator conversationId="conv-1" api={ok.api} />)
    await waitFor(() => expect(screen.getByText('9 de 30 min')).toBeTruthy())
    ok.fail('caiu')
    ok.changed('conv-1')
    await waitFor(() => expect(ok.convCalls()).toHaveLength(2))
    expect(screen.getByText('9 de 30 min')).toBeTruthy()
  })

  it('relê sozinho a cada intervalo enquanto o envio está em execução, e para quando não está', async () => {
    const m = mockApi([running(1 * MIN)])
    render(<DeadlineIndicator conversationId="conv-1" api={m.api} refreshMs={15} />)
    await shown()
    await waitFor(() => expect(m.api.handoffList.mock.calls.length).toBeGreaterThanOrEqual(3))

    m.set([envio({ status: 'concluida', entregas: [entrega({ status: 'concluida', tempoAtivoMs: 2 * MIN })] })])
    m.changed('conv-1')
    await waitFor(() => expect(screen.getByText('Etapas concluídas')).toBeTruthy())
    const calls = m.api.handoffList.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(m.api.handoffList.mock.calls.length).toBe(calls)
  })

  it('trocar de conversa lê a nova; desmontar cancela as assinaturas do aviso', async () => {
    const m = mockApi([running(4 * MIN)])
    const { rerender, unmount } = render(<DeadlineIndicator conversationId="conv-1" api={m.api} />)
    await shown()
    // A da conversa e a dos envios do plano.
    await waitFor(() => expect(m.listeners.size).toBe(2))
    m.set([{ ...running(8 * MIN), id: 'he-2', conversationId: 'conv-2' }])
    rerender(<DeadlineIndicator conversationId="conv-2" api={m.api} />)
    await waitFor(() => expect(screen.getByText('8 de 30 min')).toBeTruthy())
    expect(m.convCalls().at(-1)).toEqual({ conversationId: 'conv-2' })
    expect(m.listeners.size).toBe(2) // a assinatura da conv-1 saiu
    unmount()
    expect(m.listeners.size).toBe(0)
  })

  it('sem o canal no window.api (preload antigo, testes do App): neutro, sem quebrar', async () => {
    const saved = (window as unknown as { api?: unknown }).api
    ;(window as unknown as { api?: unknown }).api = {}
    try {
      render(<DeadlineIndicator conversationId="conv-1" />)
      await shown()
      expect(indicator()?.textContent).toBe('prazo indisponível')
      expect(level()).toBe('neutro')
    } finally {
      ;(window as unknown as { api?: unknown }).api = saved
    }
  })
})
