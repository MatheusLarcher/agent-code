/**
 * As Entregas no App inteiro: o item da barra com o contador, a tela no lugar do
 * chat, a conversa aberta por ela (ou pela barra) fechando a tela, e o toast de
 * mudança que abre a conversa. O window.api é o dublê da Central, com o
 * handoff:* em memória por cima.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { App } from '../App'
import { UiProvider } from '../ui/UiProvider'
import { conv, installApi, KEY, openConversation, seedStorage, stored, toC1, type FakeApi } from '../central/centralAppKit'
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

/** c1 ("Conversa") atrasada em execução; p1 ("Plano") aguardando você: o contador é 2. */
function world(): HandoffEnvio[] {
  return [
    envio({
      id: 'e1',
      projectCwd: '/proj',
      conversationId: 'c1',
      conversationTitle: 'Conversa',
      planTitulo: 'Checkout com Pix',
      atrasado: true,
      entregas: [entrega({ id: 'n1', envioId: 'e1', status: 'em_andamento' })]
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

const item = (): Promise<HTMLElement> => screen.findByRole('button', { name: /^Entregas/ })
const deliveriesScreen = (): HTMLElement | null => screen.queryByRole('region', { name: 'Entregas' })
const composer = (): HTMLElement | null => screen.queryByPlaceholderText(/Mensagem para o Claude/i)

async function openDeliveries(): Promise<HTMLElement> {
  fireEvent.click(await item())
  await waitFor(() => expect(deliveriesScreen()).not.toBeNull())
  const region = deliveriesScreen()!
  await waitFor(() => expect(within(region).getAllByTestId('dlv-envio')).toHaveLength(2))
  return region
}

describe('Entregas no App', () => {
  it('o item da barra mostra o contador e abre a tela no lugar do chat', async () => {
    render(<UiProvider><App /></UiProvider>)
    await waitFor(async () => expect(within(await item()).getByTestId('deliveries-count').textContent).toBe('2'))
    // Lê todos os projetos (sem filtro de conversa nem de projeto).
    expect(fake.api.handoffList).toHaveBeenCalledWith({ limit: 1000 })
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    const region = await openDeliveries()
    expect(composer()).toBeNull()
    expect((await item()).getAttribute('aria-current')).toBe('page')
    // Nenhuma conversa fica marcada na barra enquanto a tela está aberta.
    expect(document.querySelector('.conv-row.active')).toBeNull()
    // O que precisa de você vem primeiro.
    expect(within(region).getAllByTestId('dlv-envio').map((r) => r.getAttribute('data-envio-id'))).toEqual(['e2', 'e1'])
  })

  it('a conversa clicada na tela abre e a tela fecha', async () => {
    render(<UiProvider><App /></UiProvider>)
    const region = await openDeliveries()
    fireEvent.click(within(region).getByRole('button', { name: 'Conversa' }))
    await waitFor(() => expect(deliveriesScreen()).toBeNull())
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    await waitFor(() => expect(document.querySelector('.conv-row.active')?.getAttribute('title')).toMatch(/^Conversa —/))
  })

  it('clicar na barra na MESMA conversa que estava aberta também fecha a tela', async () => {
    render(<UiProvider><App /></UiProvider>)
    await openDeliveries()
    await openConversation('Conversa')
    await waitFor(() => expect(deliveriesScreen()).toBeNull())
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
  })

  it('toast de mudança (de qualquer conversa) e o clique nele abre a conversa', async () => {
    render(<UiProvider><App /></UiProvider>)
    await openDeliveries()
    const next = world().map((e) => (e.id === 'e1' ? { ...e, status: 'concluida' as const } : e))
    await fake.change(next, 'c1')
    const toast = await screen.findByText('Envio concluído: Checkout com Pix · proj (Conversa)')
    // O contador acompanha: c1 concluída não conta mais.
    await waitFor(async () => expect(within(await item()).getByTestId('deliveries-count').textContent).toBe('1'))
    fireEvent.click(toast)
    await waitFor(() => expect(deliveriesScreen()).toBeNull())
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
  })
})

/**
 * "Nova conversa" que cai na conversa vazia JÁ ativa (ela é reaproveitada): a
 * conversa ativa não muda, e mesmo assim a tela Entregas tem de fechar.
 */
describe('Entregas no App — nova conversa reaproveitando a ativa', () => {
  function seedActiveBlank(id: string, cwd: string, ui: Record<string, unknown> = {}): void {
    localStorage.setItem(KEY, JSON.stringify([...stored(), conv(id, 'Nova conversa', cwd)]))
    localStorage.setItem('agentcode.ui.v1', JSON.stringify({ collapsed: false, activeId: id, browserMinimized: true, ...ui }))
  }
  const rows = (): number => document.querySelectorAll('.conv-row').length
  const activeTitle = (): string | null | undefined => document.querySelector('.conv-row.active')?.getAttribute('title')

  it('o "+" do projeto com a vazia dele ativa fecha a tela e mostra o chat', async () => {
    seedActiveBlank('b1', '/proj')
    render(<UiProvider><App /></UiProvider>)
    await waitFor(() => expect(activeTitle()).toMatch(/^Nova conversa —/))
    const before = rows()
    await openDeliveries()
    fireEvent.click(await screen.findByTitle('Nova conversa neste projeto'))
    await waitFor(() => expect(deliveriesScreen()).toBeNull())
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    // Reaproveitou a vazia: nenhuma conversa nova, e ela é a marcada.
    expect(rows()).toBe(before)
    expect(activeTitle()).toMatch(/^Nova conversa —/)
  })

  it('"Nova conversa" do trilho (barra recolhida) com a vazia ativa fecha a tela', async () => {
    seedActiveBlank('b1', '/proj', { collapsed: true })
    render(<UiProvider><App /></UiProvider>)
    // Espera a hidratação (barra recolhida e a vazia aberta) antes de abrir a tela.
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    const newChat = (): HTMLElement | null => document.querySelector<HTMLElement>('.rail-btn.accent[title="Nova conversa"]')
    await waitFor(() => expect(newChat()).not.toBeNull())
    await openDeliveries()
    fireEvent.click(newChat()!)
    await waitFor(() => expect(deliveriesScreen()).toBeNull())
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
  })

  it('o "+" do Sandbox com a vazia do sandbox ativa fecha a tela (sem criar subpasta)', async () => {
    seedActiveBlank('sb1', 'C:\\local\\sandbox\\x')
    render(<UiProvider><App /></UiProvider>)
    const plus = await screen.findByTitle('Nova conversa no sandbox (pasta nova)')
    await openDeliveries()
    fireEvent.click(plus)
    await waitFor(() => expect(deliveriesScreen()).toBeNull())
    await screen.findByPlaceholderText(/Mensagem para o Claude/i)
    expect(api.sandboxCreate).not.toHaveBeenCalled()
  })

  it('"Novo planejamento" reabrindo o plano cuja conversa já está ativa fecha a tela', async () => {
    localStorage.setItem('agentcode.ui.v1', JSON.stringify({ collapsed: false, activeId: 'p1', browserMinimized: true }))
    const plan = (slug: string) => makePlan({ slug, roteiro: { titulo: 'Relatórios', etapas: [] }, cards: [] })
    const planningCreate = vi.fn(async (req: { slug: string }) => ({ ok: true, plan: plan(req.slug) }))
    Object.assign(api, {
      planningOpen: vi.fn(async (req: { slug: string }) => ({ ok: true, plan: plan(req.slug) })),
      planningClose: vi.fn(async () => ({ ok: true })),
      onPlanningChanged: vi.fn(() => () => {}),
      planningList: vi.fn(async () => ({ ok: true, slugs: ['plano-x'] })),
      planningCreate
    })
    render(<UiProvider><App /></UiProvider>)
    await screen.findByRole('heading', { name: 'Relatórios' })
    await openDeliveries()
    expect(screen.queryByRole('heading', { name: 'Relatórios' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Novo planejamento' }))
    fireEvent.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: /plano-x/ }))
    await waitFor(() => expect(deliveriesScreen()).toBeNull())
    expect(await screen.findByRole('heading', { name: 'Relatórios' })).toBeTruthy()
    expect(planningCreate).not.toHaveBeenCalled()
  })
})
