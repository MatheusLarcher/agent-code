import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import type { Conversation } from '../types'
import { UiProvider, useUI } from '../ui/UiProvider'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { useDeliveryCenter } from './useDeliveryCenter'
import type { DeliveriesApi } from './useDeliveries'
import { fakeDeliveriesApi } from './deliveriesFakeApi'

afterEach(cleanup)

const conv = (id: string): Conversation =>
  ({ id, title: id, cwd: 'C:/proj', model: 'm', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: 1, updatedAt: 1 }) as Conversation

/** Dois projetos: um envio em execução em cada. */
function world(): HandoffEnvio[] {
  return [
    envio({
      id: 'a',
      projectCwd: 'C:\\GitHub\\loja',
      conversationId: 'conv-a',
      entregas: [entrega({ id: 'a1', envioId: 'a', etapaTitulo: 'Backend', status: 'em_andamento' }), entrega({ id: 'a2', envioId: 'a', etapaTitulo: 'Tela', ordem: 2 })]
    }),
    envio({ id: 'b', projectCwd: '/srv/outro', planTitulo: 'Relatórios', conversationId: 'conv-b', entregas: [entrega({ id: 'b1', envioId: 'b' })] })
  ]
}

function mount(envios = world(), opts: { loaded?: string[]; fromDb?: Conversation[] } = {}) {
  const fake = fakeDeliveriesApi(envios)
  const convsRef = { current: (opts.loaded ?? ['conv-a', 'conv-b']).map(conv) }
  const spies = {
    select: vi.fn(),
    addLoaded: vi.fn(),
    loadByIds: vi.fn(async (ids: string[]) => (opts.fromDb ?? []).filter((c) => ids.includes(c.id)))
  }
  const counts: number[] = []
  function Harness(): JSX.Element {
    const { notify } = useUI()
    const center = useDeliveryCenter(
      { convsRef, loadByIds: spies.loadByIds, addLoaded: spies.addLoaded, select: spies.select, notify },
      { api: fake.api as unknown as DeliveriesApi }
    )
    counts.push(center.count)
    // <span>, não <output>: o <output> tem papel "status", como os toasts.
    return <span data-testid="count">{center.count}</span>
  }
  render(
    <UiProvider>
      <Harness />
    </UiProvider>
  )
  return { ...fake, ...spies, convsRef, counts }
}

const toasts = (): string[] => screen.queryAllByRole('status').map((t) => t.querySelector('.toast-msg')?.textContent ?? '')

function edit(list: HandoffEnvio[], id: string, fn: (e: HandoffEnvio) => HandoffEnvio): HandoffEnvio[] {
  return list.map((e) => (e.id === id ? fn(e) : e))
}

describe('useDeliveryCenter — contador e toasts de mudança', () => {
  it('a primeira leitura não gera toast, mesmo com envio concluído, parado ou atrasado', async () => {
    const start = edit(edit(world(), 'a', (e) => ({ ...e, status: 'parada', atrasado: true })), 'b', (e) => ({ ...e, status: 'concluida' }))
    const m = mount(start)
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('1'))
    expect(m.api.handoffList).toHaveBeenCalledTimes(1)
    expect(toasts()).toEqual([])
  })

  it('o contador soma aguardando você + incompleta + parada + atrasada e acompanha as mudanças', async () => {
    const m = mount()
    await waitFor(() => expect(m.api.handoffList).toHaveBeenCalled())
    expect(screen.getByTestId('count').textContent).toBe('0')
    await m.change(edit(edit(world(), 'a', (e) => ({ ...e, status: 'aguardando_voce' })), 'b', (e) => ({ ...e, atrasado: true })))
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'))
  })

  it('toasts de concluído (sucesso), incompleto, parado e atrasado (aviso), de qualquer projeto', async () => {
    const m = mount()
    await waitFor(() => expect(m.api.handoffList).toHaveBeenCalled())
    let next = edit(world(), 'a', (e) => ({ ...e, entregas: e.entregas.map((x) => (x.id === 'a1' ? { ...x, status: 'concluida' as const } : x)) }))
    next = edit(next, 'b', (e) => ({ ...e, status: 'parada' }))
    await m.change(next, 'conv-b')
    await waitFor(() => expect(toasts()).toHaveLength(2))
    expect(toasts()).toEqual(['Entrega concluída: Backend — Checkout com Pix · loja', 'Envio parado: Relatórios · outro (Implementação)'])
    const [ok, parado] = screen.getAllByRole('status')
    expect(ok.className).toContain('sucesso')
    expect(parado.className).toContain('aviso')

    const later = edit(next, 'a', (e) => ({
      ...e,
      atrasado: true,
      entregas: e.entregas.map((x) => (x.id === 'a2' ? { ...x, status: 'incompleta' as const } : x))
    }))
    await m.change(later)
    await waitFor(() => expect(toasts()).toHaveLength(4))
    expect(toasts().slice(2)).toEqual(['Entrega incompleta: Tela — Checkout com Pix · loja', 'Envio atrasado: Checkout com Pix · loja (Implementação)'])
    // A mesma leitura de novo não repete nada.
    await m.change(later)
    await waitFor(() => expect(m.api.handoffList).toHaveBeenCalledTimes(4))
    expect(toasts()).toHaveLength(4)
  })

  it('clicar no toast abre a conversa do envio (pelo mesmo caminho da barra lateral)', async () => {
    const m = mount()
    await waitFor(() => expect(m.api.handoffList).toHaveBeenCalled())
    await m.change(edit(world(), 'b', (e) => ({ ...e, status: 'concluida' })), 'conv-b')
    const toast = await screen.findByText('Envio concluído: Relatórios · outro (Implementação)')
    fireEvent.click(toast)
    expect(m.select).toHaveBeenCalledWith('conv-b')
    expect(m.loadByIds).not.toHaveBeenCalled()
  })

  it('conversa fora da 1ª página: lida do banco, posta na tela e aberta; apagada: aviso', async () => {
    const m = mount(world(), { loaded: [], fromDb: [conv('conv-a')] })
    await waitFor(() => expect(m.api.handoffList).toHaveBeenCalled())
    await m.change(edit(world(), 'a', (e) => ({ ...e, status: 'incompleta' })))
    fireEvent.click(await screen.findByText('Envio incompleto: Checkout com Pix · loja (Implementação)'))
    await waitFor(() => expect(m.select).toHaveBeenCalledWith('conv-a'))
    expect(m.loadByIds).toHaveBeenCalledWith(['conv-a'])
    expect(m.addLoaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'conv-a' }))
    expect(m.convsRef.current.map((c) => c.id)).toEqual(['conv-a'])

    await m.change(edit(world(), 'b', (e) => ({ ...e, status: 'parada' })), 'conv-b')
    fireEvent.click(await screen.findByText('Envio parado: Relatórios · outro (Implementação)'))
    await screen.findByText('A conversa deste envio não existe mais.')
    expect(m.select).not.toHaveBeenCalledWith('conv-b')
  })

  it('sem o canal no window.api (versões antigas, testes do App): nada quebra, contador zero', async () => {
    const notify = vi.fn()
    function Bare(): JSX.Element {
      const center = useDeliveryCenter({ convsRef: { current: [] }, loadByIds: async () => [], addLoaded: vi.fn(), select: vi.fn(), notify })
      return <span data-testid="count">{`${center.count}|${center.state.error}`}</span>
    }
    render(<Bare />)
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('0|o app não expõe a leitura dos envios (handoff:list)'))
    expect(notify).not.toHaveBeenCalled()
  })
})
