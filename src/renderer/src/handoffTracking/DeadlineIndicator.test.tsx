import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import type { HandoffChangedMsg, HandoffListRequest, HandoffListResult } from '@shared/api'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { DeadlineIndicator } from './DeadlineIndicator'
import { envio, entrega, MIN, running } from './handoffFixtures'

afterEach(cleanup)

/** handoff:list e handoff:changed em memória, com o aviso disparável pelo teste. */
function mockApi(initial: HandoffEnvio[]) {
  let next: HandoffListResult = { ok: true, envios: initial }
  const listeners = new Set<(msg: HandoffChangedMsg) => void>()
  const off = vi.fn()
  const api = {
    handoffList: vi.fn(async (_req?: HandoffListRequest): Promise<HandoffListResult> => structuredClone(next)),
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
    expect(screen.getByText('Etapa 1/2: Registro no banco')).toBeTruthy()
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

  it('aviso de OUTRA conversa não relê; o desta relê com os valores novos do banco', async () => {
    const m = mockApi([running(5 * MIN)])
    render(<DeadlineIndicator conversationId="conv-1" api={m.api} />)
    await shown()
    expect(m.api.handoffList).toHaveBeenCalledTimes(1)
    m.set([running(6 * MIN, { estimativaAgente: 25 })])
    m.changed('conv-2')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(m.api.handoffList).toHaveBeenCalledTimes(1)
    expect(screen.getByText('5 de 30 min')).toBeTruthy()

    m.changed('conv-1')
    await waitFor(() => expect(screen.getByText('6 de 30 min')).toBeTruthy())
    expect(screen.getByText('agente 25 min')).toBeTruthy()
    expect(m.api.handoffList).toHaveBeenCalledTimes(2)
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
    await waitFor(() => expect(ok.api.handoffList).toHaveBeenCalledTimes(2))
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

  it('trocar de conversa lê a nova; desmontar cancela a assinatura do aviso', async () => {
    const m = mockApi([running(4 * MIN)])
    const { rerender, unmount } = render(<DeadlineIndicator conversationId="conv-1" api={m.api} />)
    await shown()
    m.set([running(8 * MIN)])
    rerender(<DeadlineIndicator conversationId="conv-2" api={m.api} />)
    await waitFor(() => expect(screen.getByText('8 de 30 min')).toBeTruthy())
    expect(m.api.handoffList).toHaveBeenLastCalledWith({ conversationId: 'conv-2' })
    expect(m.off).toHaveBeenCalledTimes(1) // a assinatura da conv-1 saiu
    unmount()
    expect(m.off).toHaveBeenCalledTimes(2)
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
