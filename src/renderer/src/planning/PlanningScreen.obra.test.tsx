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
    // "requisitos" está especificada no roteiro, mas nunca foi enviada: na planta, não pronta.
    expect(within(placa).getByText('1 na massa · 1 na fila · 1 na planta')).toBeTruthy()
    expect(within(placa).getAllByRole('listitem').map((li) => li.className)).toEqual(['pl-brick b-planta', 'pl-brick b-massa', 'pl-brick b-fila'])
    // Com envios, o cabeçalho e o roteiro contam a implementação (planProgress), não a especificação.
    expect(screen.getByText('0 de 3 prontas')).toBeTruthy()
    expect(screen.getByTestId('pl-progress-count').textContent).toBe('0/3')
    expect(screen.getByTestId('pl-progress-count').getAttribute('title')).toBe('Implementação: 0 de 3 prontas')
    expect(within(placa).getByText('Implementação: Plano de teste')).toBeTruthy()
    fireEvent.click(within(placa).getByRole('button', { name: 'Ver a obra' }))
    expect(open).toHaveBeenCalledWith('impl')
    // O envio acabou: o aviso handoff:changed relê. Só as duas enviadas ficaram prontas —
    // "requisitos" segue na planta: fase entregue, não habite-se.
    const desenho = entrega({ etapaId: 'desenho', etapaTitulo: 'Desenhar a solução', status: 'concluida', ordem: 1 })
    const final = entrega({ id: 'hn-entrega', etapaId: 'entrega', etapaTitulo: 'Entregar', status: 'concluida', ordem: 2 })
    await act(async () => {
      d.set([ours({ status: 'concluida', entregas: [desenho, final] })])
    })
    expect(await screen.findByText('Fase entregue')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Placa da obra' }).dataset.stage).toBe('fase')
    expect(screen.getByText('2 de 3 prontas')).toBeTruthy()
    // Mandada e pronta também a que faltava: habite-se.
    await act(async () => {
      d.set([
        ours({ status: 'concluida', entregas: [desenho, final] }),
        ours({ id: 'he-2', loteId: 'hl-2', criadoEm: '2026-10-05T13:00:00.000Z', enviadoEm: '2026-10-05T13:00:00.000Z', status: 'concluida', entregas: [entrega({ id: 'hn-req', etapaId: 'requisitos', etapaTitulo: 'Levantar requisitos', status: 'concluida' })] })
      ])
    })
    expect(await screen.findByText('Habite-se')).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Placa da obra' }).dataset.stage).toBe('habitese')
    expect(screen.getByText('3 de 3 prontas')).toBeTruthy()
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
