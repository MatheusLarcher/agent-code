/**
 * Os envios no App inteiro, depois que a tela Entregas saiu da tela principal:
 * a barra sem "Entregas", e os toasts dos envios (de qualquer conversa) que
 * abrem a conversa no clique — inclusive o novo aviso de "a fila parou". O
 * window.api é o dublê da Central, com o handoff:* em memória por cima.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'
import { installApi, seedStorage, toC1, type FakeApi } from '../central/centralAppKit'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { makePlan } from '../planning/planningTestUtils'
import { fakeDeliveriesApi } from './deliveriesFakeApi'

configure({ asyncUtilTimeout: 10_000 })
window.HTMLElement.prototype.scrollIntoView = vi.fn()
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** c1 ("Conversa") em execução com o prompt 2 esperando; p1 ("Plano") aguardando você. */
function world(): HandoffEnvio[] {
  return [
    envio({
      id: 'e1',
      projectCwd: '/proj',
      conversationId: 'c1',
      conversationTitle: 'Conversa',
      planTitulo: 'Checkout com Pix',
      status: 'em_execucao',
      entregas: [entrega({ id: 'n1', envioId: 'e1', status: 'em_andamento' })]
    }),
    envio({
      id: 'e1b',
      projectCwd: '/proj',
      conversationId: 'c1',
      conversationTitle: 'Conversa',
      planTitulo: 'Checkout com Pix',
      ordem: 2,
      status: 'na_fila',
      enviadoEm: null,
      entregas: [entrega({ id: 'n1b', envioId: 'e1b' })]
    }),
    envio({
      id: 'e2',
      projectCwd: '/proj',
      conversationId: 'p1',
      conversationTitle: 'Plano',
      planTitulo: 'Relatórios',
      status: 'aguardando_voce',
      entregas: [entrega({ id: 'n2', envioId: 'e2' })]
    })
  ]
}

let fake: ReturnType<typeof fakeDeliveriesApi>
let api: FakeApi
beforeEach(() => {
  seedStorage()
  api = installApi(toC1)
  fake = fakeDeliveriesApi(world())
  Object.assign(api, fake.api)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('os envios no App, sem a tela Entregas', () => {
  it('a barra não tem "Entregas" e o chat fica no lugar de sempre', async () => {
    render(<UiProvider><App /></UiProvider>)
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    expect(screen.queryByRole('button', { name: /^Entregas/ })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Entregas' })).toBeNull()
    // A leitura dos envios continua (toasts e a TV Implantação).
    await waitFor(() => expect(fake.api.handoffList).toHaveBeenCalledWith({ limit: 1000 }))
  })

  it('toast de mudança (de qualquer conversa) e o clique nele abre a conversa', async () => {
    // "Plano" é a conversa de um planejamento: abrir ela monta a Tela de Planejamento.
    const plan = makePlan({ slug: 'relatorios', roteiro: { titulo: 'Relatórios', etapas: [] }, cards: [] })
    Object.assign(api, {
      planningOpen: vi.fn(async () => ({ ok: true, plan })),
      planningClose: vi.fn(async () => ({ ok: true })),
      onPlanningChanged: vi.fn(() => () => {}),
      planningList: vi.fn(async () => ({ ok: true, slugs: ['relatorios'] }))
    })
    render(<UiProvider><App /></UiProvider>)
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    await waitFor(() => expect(fake.api.handoffList).toHaveBeenCalled())
    const next = world().map((e) => (e.id === 'e2' ? { ...e, status: 'concluida' as const } : e))
    await fake.change(next, 'p1')
    fireEvent.click(await screen.findByText('Envio concluído: Relatórios · proj (Plano)'))
    await waitFor(() => expect(document.querySelector('.conv-row.active')?.getAttribute('title')).toMatch(/^Plano —/))
  })

  it('a fila parou: um aviso só, no lugar do "envio incompleto", com quantos esperam', async () => {
    render(<UiProvider><App /></UiProvider>)
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    await waitFor(() => expect(fake.api.handoffList).toHaveBeenCalled())
    const next = world().map((e) => (e.id === 'e1' ? { ...e, status: 'incompleta' as const, motivo: 'faltou [x]' } : e))
    await fake.change(next, 'c1')
    expect(await screen.findByText('A fila parou: Checkout com Pix · proj — 1 prompt espera no quadro')).toBeTruthy()
    expect(screen.queryByText(/^Envio incompleto: Checkout com Pix/)).toBeNull()
  })
})
