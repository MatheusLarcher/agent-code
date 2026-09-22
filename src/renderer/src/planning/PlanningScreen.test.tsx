import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { PlanningScreen } from './PlanningScreen'
import { CWD, SLUG, makeCard, makePlan, mockPlanningApi, stubResizeObserver } from './planningTestUtils'

beforeAll(stubResizeObserver)
beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderScreen() {
  return render(
    <UiProvider>
      <PlanningScreen
        projectCwd={CWD}
        slug={SLUG}
        headerActions={<button type="button">Enviar para implementação</button>}
        chatSlot={<div>conversa com o agente</div>}
      />
    </UiProvider>
  )
}

describe('PlanningScreen — estados', () => {
  it('mostra "carregando" e depois o título, o roteiro, as ações e o chat', async () => {
    mockPlanningApi()
    renderScreen()
    expect(screen.getByText(/Carregando o planejamento/)).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'Plano de teste' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enviar para implementação' })).toBeTruthy()
    expect(screen.getByText('conversa com o agente')).toBeTruthy()
    expect(screen.getByTestId('pl-progress-count').textContent).toBe('1/3')
    expect(screen.getByText('1 de 3 etapas')).toBeTruthy()
  })

  it('erro ao abrir mostra o motivo e "Tentar de novo" reabre', async () => {
    const { api } = mockPlanningApi()
    api.planningOpen.mockResolvedValueOnce({ ok: false, code: 'not_found', message: 'plano não existe' } as never)
    renderScreen()
    expect(await screen.findByText('plano não existe')).toBeTruthy()
    // O chat continua de pé mesmo com o plano quebrado.
    expect(screen.getByText('conversa com o agente')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByRole('heading', { name: 'Plano de teste' })).toBeTruthy()
    expect(api.planningOpen).toHaveBeenCalledTimes(2)
  })

  it('plano vazio mostra o estado em branco e o "+ Card" abre o editor', async () => {
    mockPlanningApi(makePlan({ roteiro: { titulo: 'Novo plano', etapas: [] }, cards: [] }))
    renderScreen()
    expect(await screen.findByText('Plano em branco')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '+ Card' }))
    expect(screen.getByRole('dialog', { name: 'Novo card' })).toBeTruthy()
  })

  it('avisa dos cards inválidos listando os arquivos', async () => {
    mockPlanningApi(
      makePlan({
        invalid: [
          { file: 'cards/quebrado.md', error: 'card sem frontmatter' },
          { file: 'cards/sem-fonte.md', error: 'card de sugestão exige fonte' }
        ]
      })
    )
    renderScreen()
    const alert = await screen.findByText('2 cards não carregaram')
    const box = alert.closest('.pl-invalid') as HTMLElement
    expect(within(box).getByText('cards/quebrado.md')).toBeTruthy()
    expect(within(box).getByText('cards/sem-fonte.md')).toBeTruthy()
    expect(within(box).getByText('card sem frontmatter')).toBeTruthy()
  })
})

describe('PlanningScreen — canvas', () => {
  it('desenha as colunas das etapas, "Sem etapa" e os cards', async () => {
    mockPlanningApi(
      makePlan({
        cards: [
          makeCard('login', { etapa: 'requisitos', titulo: 'Login com SSO' }),
          makeCard('fonte', { tipo: 'sugestao', titulo: 'Usar OAuth PKCE', fonte: 'https://www.oauth.net/2/pkce/' }),
          makeCard('duvida', { tipo: 'ambiguidade', titulo: 'Quem aprova?', status: 'aberta' })
        ]
      })
    )
    const { container } = renderScreen()
    expect(await screen.findByText('Login com SSO')).toBeTruthy()
    const stages = [...container.querySelectorAll('.pl-stage-title')].map((el) => el.textContent)
    expect(stages).toEqual(['Levantar requisitos', 'Desenhar a solução', 'Entregar', 'Sem etapa'])
    expect(screen.getByTestId('pl-card-fonte').getAttribute('data-tipo')).toBe('sugestao')
    // Nó ainda não medido fica visibility:hidden no jsdom — por isso texto, não role.
    const source = within(screen.getByTestId('pl-card-fonte')).getByText(/oauth\.net/).closest('a')
    expect(source?.getAttribute('href')).toBe('https://www.oauth.net/2/pkce/')
    expect(within(screen.getByTestId('pl-card-duvida')).getByText('aberta')).toBeTruthy()
  })

  it('duplo clique no card abre o editor e salvar grava com o rev do card', async () => {
    const { api } = mockPlanningApi()
    renderScreen()
    const node = await screen.findByTestId('pl-card-login')
    fireEvent.doubleClick(node)
    const dialog = await screen.findByRole('dialog', { name: 'Editar card' })
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Login revisto' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(api.planningSaveCard).toHaveBeenCalledTimes(1))
    expect(api.planningSaveCard).toHaveBeenCalledWith(expect.objectContaining({ expectedRev: 4 }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar card' })).toBeNull())
    expect(await screen.findByText('Login revisto')).toBeTruthy()
  })

  it('apagar pede confirmação antes de chamar planningDeleteCard', async () => {
    const { api } = mockPlanningApi()
    renderScreen()
    fireEvent.doubleClick(await screen.findByTestId('pl-card-banco'))
    const dialog = await screen.findByRole('dialog', { name: 'Editar card' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apagar' }))
    expect(await screen.findByText('Apagar card?')).toBeTruthy()
    expect(api.planningDeleteCard).not.toHaveBeenCalled()
    const confirmBtn = document.querySelector('.modal-card .danger-btn') as HTMLButtonElement
    fireEvent.click(confirmBtn)
    await waitFor(() =>
      expect(api.planningDeleteCard).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG, id: 'banco', expectedRev: 2 })
    )
    await waitFor(() => expect(screen.queryByTestId('pl-card-banco')).toBeNull())
    expect(screen.queryByRole('dialog', { name: 'Editar card' })).toBeNull()
  })

  it('conflito ao salvar reabre o editor com a versão do disco', async () => {
    const mock = mockPlanningApi()
    const current = makeCard('login', { etapa: 'requisitos', titulo: 'Versão do agente', rev: 6 })
    mock.api.planningSaveCard.mockResolvedValueOnce({ ok: false, code: 'rev_conflict', current } as never)
    renderScreen()
    fireEvent.doubleClick(await screen.findByTestId('pl-card-login'))
    const dialog = await screen.findByRole('dialog', { name: 'Editar card' })
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Minha versão' } })
    mock.setPlan(makePlan({ cards: [current] }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('Versão do agente'))
    expect(screen.getByText(/O card mudou enquanto você editava/)).toBeTruthy()
  })
})

describe('PlanningScreen — enquadramento e espaço', () => {
  it('reabrir o plano restaura o viewport salvo em _canvas.json', async () => {
    mockPlanningApi(makePlan({ layout: { positions: {}, viewport: { x: 40, y: -12, zoom: 1.25 } } }))
    const { container } = renderScreen()
    await screen.findByTestId('pl-card-login')
    const viewport = container.querySelector('.react-flow__viewport') as HTMLElement
    expect(viewport.style.transform.replace(/\s+/g, '')).toBe('translate(40px,-12px)scale(1.25)')
  })

  it('o chat abre com 380px e a largura escolhida volta na próxima abertura', async () => {
    mockPlanningApi()
    const { container, unmount } = renderScreen()
    await screen.findByTestId('pl-card-login')
    const chat = () => container.querySelector('.pl-chat') as HTMLElement
    expect(chat().style.getPropertyValue('--pl-chat-w')).toBe('380px')
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Largura do chat' }), { key: 'ArrowLeft' })
    expect(chat().style.getPropertyValue('--pl-chat-w')).toBe('396px')
    unmount()
    mockPlanningApi()
    const again = renderScreen()
    await screen.findByTestId('pl-card-login')
    expect((again.container.querySelector('.pl-chat') as HTMLElement).style.getPropertyValue('--pl-chat-w')).toBe('396px')
  })

  it('o divisor não passa da metade da tela nem fica abaixo de 320px', async () => {
    mockPlanningApi()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect)
    renderScreen()
    await screen.findByTestId('pl-card-login')
    const sep = screen.getByRole('separator', { name: 'Largura do chat' })
    fireEvent.pointerDown(sep, { clientX: 700, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 0, pointerId: 1 })
    fireEvent.pointerUp(sep, { pointerId: 1 })
    expect(sep.getAttribute('aria-valuenow')).toBe('500')
    fireEvent.keyDown(sep, { key: 'Home' })
    expect(sep.getAttribute('aria-valuenow')).toBe('320')
  })

  it('recolher o roteiro deixa um trilho com o contador, e fica recolhido na próxima abertura', async () => {
    mockPlanningApi()
    const { container, unmount } = renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: 'Recolher o roteiro' }))
    expect(container.querySelector('.pl-rail')).toBeTruthy()
    expect(container.querySelector('.pl-progress-list')).toBeNull()
    expect(screen.getByTestId('pl-progress-count').textContent).toBe('1/3')
    unmount()
    mockPlanningApi()
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: 'Mostrar o roteiro' }))
    expect(screen.getByText('Levantar requisitos', { selector: '.pl-step-title' })).toBeTruthy()
  })
})
