import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { UiProvider } from '../ui/UiProvider'
import { entrega, envio, MIN } from '../handoffTracking/handoffFixtures'
import { DeliveriesScreen } from './DeliveriesScreen'
import { useDeliveries, type DeliveriesApi } from './useDeliveries'
import { fakeDeliveriesApi } from './deliveriesFakeApi'

afterEach(cleanup)

const at = (min: number): string => new Date(Date.UTC(2026, 9, 5, 12, min)).toISOString()

/** Três projetos, cada envio num estado. */
function world(): HandoffEnvio[] {
  return [
    envio({
      id: 'e-concluida',
      status: 'concluida',
      projectCwd: 'C:\\GitHub\\loja',
      planTitulo: 'Painel de vendas',
      conversationId: 'conv-painel',
      conversationTitle: 'Implementação: painel',
      updatedAt: at(9),
      entregas: [entrega({ id: 'p1', envioId: 'e-concluida', etapaTitulo: 'Gráfico', status: 'concluida', auditada: false })]
    }),
    envio({
      id: 'e-exec',
      status: 'em_execucao',
      projectCwd: '/home/eu/app',
      planTitulo: 'Pá de cal no legado',
      conversationId: 'conv-pa',
      conversationTitle: 'Limpeza',
      prazoTotal: 50,
      tempoAtivoMs: 42 * MIN,
      updatedAt: at(8),
      entregas: [
        entrega({ id: 'x1', envioId: 'e-exec', etapaTitulo: 'Remover módulo', ordem: 1, status: 'concluida', corrigidoPor: 'usuario', corrigidoEm: at(5) }),
        entrega({
          id: 'x2',
          envioId: 'e-exec',
          etapaTitulo: 'Testes',
          ordem: 2,
          status: 'em_andamento',
          estimativaPlano: 20,
          estimativaAgente: 25,
          tempoAtivoMs: 12 * MIN
        })
      ]
    }),
    envio({
      id: 'e-aguardando',
      status: 'aguardando_voce',
      projectCwd: 'C:\\GitHub\\agent-code',
      planTitulo: 'Checkout com Pix',
      conversationId: 'conv-1',
      conversationTitle: 'Implementação: checkout',
      atrasado: true,
      updatedAt: at(1),
      entregas: [entrega({ id: 'c1', envioId: 'e-aguardando', etapaTitulo: 'Registro no banco', status: 'incompleta', atrasada: true, motivo: 'faltou a migração' })]
    })
  ]
}

function mount(envios = world(), onOpen = vi.fn()) {
  const fake = fakeDeliveriesApi(envios)
  function Harness(): JSX.Element {
    const state = useDeliveries({ api: fake.api as unknown as DeliveriesApi })
    return <DeliveriesScreen state={state} onOpenConversation={onOpen} />
  }
  render(
    <UiProvider>
      <Harness />
    </UiProvider>
  )
  return { ...fake, onOpen }
}

const rows = (): HTMLElement[] => screen.queryAllByTestId('dlv-envio')
const plans = (): string[] => rows().map((r) => r.querySelector('.dlv-plan')?.textContent ?? '')

describe('DeliveriesScreen', () => {
  it('lê todos os envios (sem filtro) ao abrir e mostra primeiro o que precisa de você', async () => {
    const m = mount()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(m.api.handoffList).toHaveBeenCalledWith({ limit: 1000 })
    expect(plans()).toEqual(['Checkout com Pix', 'Pá de cal no legado', 'Painel de vendas'])
    expect(screen.getByText(/3 envios de todos os projetos · 1 precisa de você/)).toBeTruthy()
  })

  it('cada envio: projeto, plano, conversa, status, atraso, etapa atual, progresso e estimado × real', async () => {
    mount()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const exec = within(rows()[1])
    expect(exec.getByText('app')).toBeTruthy()
    expect(exec.getByText('Limpeza')).toBeTruthy()
    expect(exec.getByText('em execução')).toBeTruthy()
    expect(exec.getByText('Etapa 2/2: Testes')).toBeTruthy()
    expect(exec.getByText('1/2')).toBeTruthy()
    expect(exec.getByText('estimado 50 min × real 42 min')).toBeTruthy()
    const aguardando = within(rows()[0])
    expect(aguardando.getByText('aguardando você')).toBeTruthy()
    expect(aguardando.getByText('atrasada')).toBeTruthy()
    expect(aguardando.getByText('agent-code')).toBeTruthy()
  })

  it('o clique na conversa a abre', async () => {
    const m = mount()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Limpeza' }))
    expect(m.onOpen).toHaveBeenCalledWith('conv-pa')
  })

  it('expande o envio: as entregas com status, atraso, plano × agente × real, não auditada e corrigida por você', async () => {
    mount()
    await waitFor(() => expect(rows()).toHaveLength(3))
    expect(screen.queryAllByTestId('dlv-entrega')).toHaveLength(0)
    const toggle = screen.getByRole('button', { name: 'Ver as entregas de Pá de cal no legado' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const [primeira, segunda] = screen.getAllByTestId('dlv-entrega')
    expect(within(primeira).getByText('corrigida por você')).toBeTruthy()
    expect(within(segunda).getByText('em andamento')).toBeTruthy()
    expect(segunda.querySelector('.dlv-entrega-times')?.textContent).toBe('plano 20 min×agente 25 min×real 12 min')
    fireEvent.click(screen.getByRole('button', { name: 'Ver as entregas de Painel de vendas' }))
    expect(screen.getByText('não auditada')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Ver as entregas de Checkout com Pix' }))
    expect(screen.getByText('faltou a migração')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Esconder as entregas de Pá de cal no legado' }))
    expect(screen.getAllByTestId('dlv-entrega')).toHaveLength(2)
  })

  it.each([
    ['Aguardando você', ['Checkout com Pix']],
    ['Atrasada', ['Checkout com Pix']],
    ['Em execução', ['Pá de cal no legado']],
    ['Concluída', ['Painel de vendas']],
    ['Incompleta', []],
    ['Parada', []]
  ])('filtro %s', async (label, expected) => {
    mount()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const chip = screen.getByRole('button', { name: new RegExp(`^${label}`) })
    fireEvent.click(chip)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(plans()).toEqual(expected)
    // De novo no mesmo filtro: volta a mostrar todos.
    fireEvent.click(chip)
    expect(rows()).toHaveLength(3)
  })

  it('busca sem acento e sem maiúsculas nos dois sentidos: "pa" acha "Pá" e "pá" acha "Pa"', async () => {
    mount()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const search = screen.getByRole('searchbox', { name: 'Buscar entregas' })
    fireEvent.change(search, { target: { value: 'pa' } })
    expect(plans()).toEqual(['Pá de cal no legado', 'Painel de vendas'])
    fireEvent.change(search, { target: { value: 'pá' } })
    expect(plans()).toEqual(['Pá de cal no legado', 'Painel de vendas'])
    fireEvent.change(search, { target: { value: 'pa de' } })
    expect(plans()).toEqual(['Pá de cal no legado'])
    fireEvent.change(search, { target: { value: 'PÁINEL' } })
    expect(plans()).toEqual(['Painel de vendas'])
    // Projeto, conversa e etapa também entram.
    fireEvent.change(search, { target: { value: 'agent-code' } })
    expect(plans()).toEqual(['Checkout com Pix'])
    fireEvent.change(search, { target: { value: 'remover modulo' } })
    expect(plans()).toEqual(['Pá de cal no legado'])
    fireEvent.change(search, { target: { value: 'nada disso' } })
    expect(screen.getByText('Nenhum envio com esse filtro ou busca.')).toBeTruthy()
  })

  it('correção manual: concluir chama handoff:correctEntrega e avisa o sucesso', async () => {
    const m = mount()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Ver as entregas de Checkout com Pix' }))
    fireEvent.click(screen.getByRole('button', { name: 'Marcar como concluída' }))
    await waitFor(() => expect(m.api.handoffCorrectEntrega).toHaveBeenCalledWith({ entregaId: 'c1', acao: 'concluir' }))
    await screen.findByText('Entrega "Registro no banco" marcada como concluída.')
    // O envio devolvido já entra na lista: a entrega aparece concluída e corrigida por você.
    const entregaRow = screen.getByTestId('dlv-entrega')
    await waitFor(() => expect(within(entregaRow).getByText('concluída')).toBeTruthy())
    expect(within(entregaRow).getByText('corrigida por você')).toBeTruthy()
  })

  it('correção manual: reabrir; erro do main vira toast de erro', async () => {
    const m = mount()
    await waitFor(() => expect(rows()).toHaveLength(3))
    fireEvent.click(screen.getByRole('button', { name: 'Ver as entregas de Painel de vendas' }))
    expect(screen.queryByRole('button', { name: 'Marcar como concluída' })).toBeNull()
    m.api.handoffCorrectEntrega.mockResolvedValueOnce({ ok: false, message: 'O acompanhamento dos envios não está ativo.' })
    fireEvent.click(screen.getByRole('button', { name: 'Reabrir' }))
    await waitFor(() => expect(m.api.handoffCorrectEntrega).toHaveBeenCalledWith({ entregaId: 'p1', acao: 'reabrir' }))
    await screen.findByText('Não consegui corrigir a entrega "Gráfico": O acompanhamento dos envios não está ativo.')
    m.api.handoffCorrectEntrega.mockRejectedValueOnce(new Error("Error invoking remote method 'handoff:correctEntrega': Error: banco fora"))
    fireEvent.click(screen.getByRole('button', { name: 'Reabrir' }))
    await screen.findByText('Não consegui corrigir a entrega "Gráfico": banco fora')
  })

  it('relê a cada handoff:changed de qualquer conversa', async () => {
    const m = mount()
    await waitFor(() => expect(rows()).toHaveLength(3))
    const next = world()
    next[1] = { ...next[1], status: 'parada' }
    await m.change(next, 'conv-de-outro-projeto')
    await waitFor(() => expect(within(rows()[1]).queryByText('parada')).not.toBeNull())
    // A parada (mais recente) fica abaixo do "aguardando você" (mais antigo).
    expect(plans()).toEqual(['Checkout com Pix', 'Pá de cal no legado', 'Painel de vendas'])
  })

  it('sem envio nenhum e com o banco fora: mensagens claras', async () => {
    const m = mount([])
    await screen.findByText(/Nenhum envio registrado ainda/)
    m.api.handoffList.mockResolvedValue({ ok: false, message: 'O banco está indisponível agora.' })
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }))
    await screen.findByText('Não consegui ler as entregas do banco: O banco está indisponível agora.')
  })
})
