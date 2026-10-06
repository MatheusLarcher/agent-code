import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { UiProvider } from '../ui/UiProvider'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { PlanningScreen } from './PlanningScreen'
import { CWD, SLUG, mockPlanningApi, stubResizeObserver } from './planningTestUtils'

beforeAll(stubResizeObserver)
beforeEach(() => localStorage.clear())
afterEach(async () => {
  cleanup()
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })
  vi.restoreAllMocks()
})

/** O plano do mockPlanningApi tem as etapas requisitos (concluída), desenho e entrega. */
function withDeliveries(initial: HandoffEnvio[]) {
  const planning = mockPlanningApi()
  let envios = initial
  const listeners = new Set<(msg: { conversationId: string }) => void>()
  const api = planning.api as unknown as Record<string, unknown>
  api.handoffList = vi.fn(async () => ({ ok: true as const, envios }))
  api.onHandoffChanged = vi.fn((cb: (msg: { conversationId: string }) => void) => {
    listeners.add(cb)
    return () => void listeners.delete(cb)
  })
  return {
    api,
    set(next: HandoffEnvio[]): void {
      envios = next
      for (const cb of [...listeners]) cb({ conversationId: 'impl' })
    }
  }
}

const ours = (over: Partial<HandoffEnvio>): HandoffEnvio =>
  envio({ planSlug: SLUG, projectCwd: CWD, conversationId: 'impl', conversationTitle: 'Implementação: Plano de teste', ...over })

function renderScreen(onOpenConversation = vi.fn()) {
  render(
    <UiProvider>
      <PlanningScreen projectCwd={CWD} slug={SLUG} onOpenConversation={onOpenConversation} />
    </UiProvider>
  )
  return onOpenConversation
}

describe('PlanningScreen — a obra do plano', () => {
  it('sem envio: o selo "Na prancheta" e nada de placa', async () => {
    withDeliveries([envio({ planSlug: 'outro-plano', projectCwd: CWD })])
    renderScreen()
    expect(await screen.findByText('Na prancheta')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Placa da obra' })).toBeNull()
  })

  it('enviado e em execução: selo "Em obra" e a placa com a etapa, os tijolos, o mestre de obras e "Ver a obra"; o aviso de mudança relê', async () => {
    const d = withDeliveries([
      ours({
        status: 'em_execucao',
        entregas: [
          entrega({ etapaId: 'desenho', etapaTitulo: 'Desenhar a solução', status: 'em_andamento', ordem: 1 }),
          entrega({ id: 'hn-entrega', etapaId: 'entrega', etapaTitulo: 'Entregar', status: 'pendente', ordem: 2 })
        ]
      })
    ])
    const open = renderScreen()
    expect(await screen.findByText('Em obra')).toBeTruthy()
    const placa = screen.getByRole('region', { name: 'Placa da obra' })
    expect(within(placa).getByText('Etapa 2 de 3')).toBeTruthy()
    expect(within(placa).getByText(/Mão na massa: Desenhar a solução/)).toBeTruthy()
    expect(within(placa).getByText('1 pronta · 1 na massa · 1 na fila')).toBeTruthy()
    expect(within(placa).getAllByRole('listitem').map((li) => li.className)).toEqual(['pl-brick b-pronto', 'pl-brick b-massa', 'pl-brick b-fila'])
    expect(within(placa).getByText('Implementação: Plano de teste')).toBeTruthy()
    fireEvent.click(within(placa).getByRole('button', { name: 'Ver a obra' }))
    expect(open).toHaveBeenCalledWith('impl')
    // A implementação acabou: o aviso handoff:changed relê e a obra vira habite-se.
    await act(async () => {
      d.set([
        ours({
          status: 'concluida',
          entregas: [
            entrega({ etapaId: 'desenho', etapaTitulo: 'Desenhar a solução', status: 'concluida', ordem: 1 }),
            entrega({ id: 'hn-entrega', etapaId: 'entrega', etapaTitulo: 'Entregar', status: 'concluida', ordem: 2 })
          ]
        })
      ])
    })
    expect(await screen.findByText('Habite-se')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Placa da obra' }).dataset.stage).toBe('habitese')
  })

  it('sem leitura do banco não inventa estágio: nem selo nem placa', async () => {
    const d = withDeliveries([])
    d.api.handoffList = vi.fn(async () => ({ ok: false as const, message: 'banco fora' }))
    renderScreen()
    expect(await screen.findByRole('heading', { name: 'Plano de teste' })).toBeTruthy()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(screen.queryByText('Na prancheta')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Placa da obra' })).toBeNull()
  })
})
