import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { useChatDisplay } from '../components/chatDisplay'
import { PlanningScreen } from './PlanningScreen'
import { CWD, SLUG, makeCard, makePlan, mockPlanningApi, stubResizeObserver } from './planningTestUtils'

beforeAll(stubResizeObserver)
beforeEach(() => localStorage.clear())
afterEach(async () => {
  cleanup()
  // O editor grava no unmount num setTimeout: roda aqui, com os mocks deste teste.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5))
  })
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

  it('sugestão com fonte em arquivo do projeto mostra o arquivo como texto, não como link', async () => {
    mockPlanningApi(
      makePlan({ cards: [makeCard('reuso', { tipo: 'sugestao', titulo: 'Reusar o parser', fonte: 'src/main/parser.ts:42' })] })
    )
    renderScreen()
    const node = await screen.findByTestId('pl-card-reuso')
    const source = within(node).getByText('parser.ts:42')
    expect(source.closest('a')).toBeNull()
    expect(source.getAttribute('title')).toMatch(/src\/main\/parser\.ts:42/)
  })

  it('duplo clique abre o editor sem botão Salvar; Fechar grava com o rev do card e fecha', async () => {
    const { api } = mockPlanningApi()
    renderScreen()
    const node = await screen.findByTestId('pl-card-login')
    fireEvent.doubleClick(node)
    const dialog = await screen.findByRole('dialog', { name: 'Editar card' })
    expect(within(dialog).queryByRole('button', { name: 'Salvar' })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: 'Cancelar' })).toBeNull()
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Login revisto' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }))
    await waitFor(() => expect(api.planningSaveCard).toHaveBeenCalledTimes(1))
    expect(api.planningSaveCard).toHaveBeenCalledWith(expect.objectContaining({ expectedRev: 4 }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar card' })).toBeNull())
    expect(await screen.findByText('Login revisto')).toBeTruthy()
  })

  it('clicar fora grava e o editor continua aberto; abrir outro card grava o anterior', async () => {
    const { api } = mockPlanningApi()
    renderScreen()
    fireEvent.doubleClick(await screen.findByTestId('pl-card-login'))
    let dialog = await screen.findByRole('dialog', { name: 'Editar card' })
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Login v2' } })
    fireEvent.focusOut(within(dialog).getByLabelText('Título'), { relatedTarget: null })
    await waitFor(() => expect(api.planningSaveCard).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('dialog', { name: 'Editar card' })).toBeTruthy()

    // Muda de novo e troca de card sem sair do painel: o anterior grava sobre o rev novo (5).
    dialog = screen.getByRole('dialog', { name: 'Editar card' })
    fireEvent.change(within(dialog).getByLabelText('Conteúdo'), { target: { value: 'corpo novo' } })
    fireEvent.doubleClick(screen.getByTestId('pl-card-banco'))
    await waitFor(() => expect(api.planningSaveCard).toHaveBeenCalledTimes(2))
    expect(api.planningSaveCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRev: 5, card: expect.objectContaining({ id: 'login', titulo: 'Login v2', corpo: 'corpo novo' }) })
    )
    expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('Usar Postgres')
  })

  it('card novo: Fechar grava com o id tirado do título e expectedRev 0', async () => {
    const { api } = mockPlanningApi(makePlan({ roteiro: { titulo: 'Novo plano', etapas: [] }, cards: [] }))
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: '+ Card' }))
    const dialog = screen.getByRole('dialog', { name: 'Novo card' })
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Decidir o banco' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }))
    await waitFor(() =>
      expect(api.planningSaveCard).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRev: 0, card: expect.objectContaining({ id: 'decidir-o-banco', titulo: 'Decidir o banco' }) })
      )
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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

  it('conflito ao gravar: mescla por campo com a versão do Manager, grava de novo e avisa uma vez', async () => {
    const mock = mockPlanningApi()
    const current = makeCard('login', { etapa: 'requisitos', titulo: 'Login com SSO', corpo: 'Corpo do agente', rev: 6 })
    mock.api.planningSaveCard.mockResolvedValueOnce({ ok: false, code: 'rev_conflict', current } as never)
    renderScreen()
    fireEvent.doubleClick(await screen.findByTestId('pl-card-login'))
    const dialog = await screen.findByRole('dialog', { name: 'Editar card' })
    fireEvent.change(within(dialog).getByLabelText('Título'), { target: { value: 'Minha versão' } })
    mock.setPlan(makePlan({ cards: [current] }))
    fireEvent.focusOut(within(dialog).getByLabelText('Título'), { relatedTarget: null })
    await waitFor(() => expect(mock.api.planningSaveCard).toHaveBeenCalledTimes(2))
    expect(mock.api.planningSaveCard).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRev: 6, card: expect.objectContaining({ titulo: 'Minha versão', corpo: 'Corpo do agente' }) })
    )
    expect(await screen.findByText(/juntei as duas versões/)).toBeTruthy()
    expect(screen.queryByText(/O card mudou enquanto você editava/)).toBeNull()
    expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe('Minha versão')
    // O campo que só o Manager mudou aparece no editor com a versão dele.
    await waitFor(() => expect((screen.getByLabelText('Conteúdo') as HTMLTextAreaElement).value).toBe('Corpo do agente'))
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

  const roteiroW = (container: HTMLElement): string =>
    (container.querySelector('.pl-body') as HTMLElement).style.getPropertyValue('--pl-roteiro-w')

  it('o roteiro abre com 220px, a alça ajusta pelo teclado e a largura volta na próxima abertura', async () => {
    mockPlanningApi()
    const { container, unmount } = renderScreen()
    await screen.findByTestId('pl-card-login')
    expect(roteiroW(container)).toBe('220px')
    const sep = screen.getByRole('separator', { name: 'Largura do roteiro' })
    // A alça fica na borda direita do roteiro, antes do canvas.
    expect(sep.previousElementSibling?.classList.contains('pl-progress')).toBe(true)
    expect(sep.nextElementSibling?.classList.contains('pl-main')).toBe(true)
    fireEvent.keyDown(sep, { key: 'ArrowRight' })
    expect(roteiroW(container)).toBe('236px')
    expect(sep.getAttribute('aria-valuenow')).toBe('236')
    unmount()
    mockPlanningApi()
    const again = renderScreen()
    await screen.findByTestId('pl-card-login')
    expect(roteiroW(again.container)).toBe('236px')
  })

  it('a alça não passa de 40% da área da tela nem fica abaixo de 180px', async () => {
    mockPlanningApi()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1000 } as DOMRect)
    renderScreen()
    await screen.findByTestId('pl-card-login')
    const sep = screen.getByRole('separator', { name: 'Largura do roteiro' })
    expect(sep.getAttribute('aria-valuemax')).toBe('400')
    fireEvent.pointerDown(sep, { clientX: 220, button: 0, pointerId: 1 })
    fireEvent.pointerMove(sep, { clientX: 1200, pointerId: 1 })
    fireEvent.pointerUp(sep, { pointerId: 1 })
    expect(sep.getAttribute('aria-valuenow')).toBe('400')
    expect(localStorage.getItem('agentcode.planning.roteiroWidth')).toBe('400')
    fireEvent.keyDown(sep, { key: 'Home' })
    expect(sep.getAttribute('aria-valuenow')).toBe('180')
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

  it('recolhido não tem alça; ao expandir, o roteiro volta à última largura', async () => {
    mockPlanningApi()
    const { container } = renderScreen()
    await screen.findByTestId('pl-card-login')
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Largura do roteiro' }), { key: 'ArrowRight' })
    fireEvent.click(screen.getByRole('button', { name: 'Recolher o roteiro' }))
    expect(screen.queryByRole('separator', { name: 'Largura do roteiro' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar o roteiro' }))
    expect(roteiroW(container)).toBe('236px')
    expect(screen.getByRole('separator', { name: 'Largura do roteiro' }).getAttribute('aria-valuenow')).toBe('236')
  })
})

describe('PlanningScreen — chat flutuante', () => {
  it('o chat não é mais coluna: flutua na área do canvas, que ocupa o resto da tela', async () => {
    mockPlanningApi()
    const { container } = renderScreen()
    await screen.findByTestId('pl-card-login')
    const float = screen.getByRole('region', { name: 'Agent Manager' })
    expect(within(float).getByText('conversa com o agente')).toBeTruthy()
    const main = container.querySelector('.pl-body > .pl-main') as HTMLElement
    expect(float.parentElement).toBe(main)
    // O canvas é irmão do painel, não está dentro dele: fora da caixa do painel, o canvas recebe o mouse.
    expect(main.querySelector(':scope > .pl-stage-area .react-flow')).toBeTruthy()
    expect(float.querySelector('.react-flow')).toBeNull()
    // Não sobra nada da coluna antiga: só a alça do roteiro é separador.
    expect(screen.getAllByRole('separator').map((s) => s.getAttribute('aria-label'))).toEqual(['Largura do roteiro'])
    expect(container.querySelector('.pl-body > .pl-main')?.nextElementSibling).toBeNull()
  })

  it('minimizar vale para a próxima abertura; o padrão é maximizado', async () => {
    mockPlanningApi()
    const { unmount } = renderScreen()
    await screen.findByTestId('pl-card-login')
    const float = screen.getByRole('region', { name: 'Agent Manager' })
    expect(float.classList.contains('minimized')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Minimizar o chat do Agent Manager' }))
    expect(float.classList.contains('minimized')).toBe(true)
    unmount()
    mockPlanningApi()
    renderScreen()
    await screen.findByTestId('pl-card-login')
    expect(screen.getByRole('region', { name: 'Agent Manager' }).classList.contains('minimized')).toBe(true)
    expect(screen.getByRole('button', { name: 'Maximizar o chat do Agent Manager' })).toBeTruthy()
  })

  it('o chat recebe os cards do plano (os mesmos do canvas) e acompanha a recarga do plano', async () => {
    function ChatCards(): JSX.Element {
      const { cardRefs } = useChatDisplay()
      return <span data-testid="chat-cards">{cardRefs?.map((c) => `${c.tipo}:${c.titulo}`).join('|') ?? 'sem cards'}</span>
    }
    const mock = mockPlanningApi()
    render(
      <UiProvider>
        <PlanningScreen projectCwd={CWD} slug={SLUG} chatSlot={<ChatCards />} />
      </UiProvider>
    )
    await screen.findByTestId('pl-card-login')
    expect(screen.getByTestId('chat-cards').textContent).toBe('requisito:Login com SSO|decisao:Usar Postgres')

    // O Manager grava um card novo e renomeia outro: o plano recarrega e o chat vê o mesmo que o canvas.
    mock.setPlan(
      makePlan({
        cards: [
          makeCard('login', { etapa: 'requisitos', titulo: 'Login com SSO', rev: 4 }),
          makeCard('banco', { tipo: 'decisao', etapa: 'desenho', titulo: 'Usar SQLite', rev: 3 }),
          makeCard('duvida', { tipo: 'ambiguidade', titulo: 'Quem aprova?', status: 'aberta' })
        ]
      })
    )
    await act(async () => mock.emitChanged({ projectCwd: CWD, slug: SLUG }))
    await screen.findByTestId('pl-card-duvida')
    expect(screen.getByTestId('chat-cards').textContent).toBe(
      'requisito:Login com SSO|decisao:Usar SQLite|ambiguidade:Quem aprova?'
    )
  })

  it('o minimapa fica em cima à direita, longe do chat minimizado', async () => {
    mockPlanningApi()
    const { container } = renderScreen()
    await screen.findByTestId('pl-card-login')
    const minimap = container.querySelector('.react-flow__minimap') as HTMLElement
    expect(minimap.classList.contains('top')).toBe(true)
    expect(minimap.classList.contains('right')).toBe(true)
    expect((container.querySelector('.react-flow__controls') as HTMLElement).classList.contains('bottom')).toBe(true)
  })
})
