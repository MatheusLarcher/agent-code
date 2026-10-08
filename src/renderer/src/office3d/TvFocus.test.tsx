import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { HandoffEnvio } from '@shared/handoffTracking'
import type { PlanningPeekDto } from '@shared/officeApi'
import { DeliveryCenterContext, type DeliveryCenterValue } from '../deliveries/deliveryCenterContext'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { HandoffButton } from '../planning/HandoffDialog'
import { clearHandoffSession } from '../planning/handoffFlow'
import { PlanningWorkspace } from '../planning/PlanningWorkspace'
import { CWD, SLUG, mockPlanningApi, stubResizeObserver } from '../planning/planningTestUtils'
import { UiProvider } from '../ui/UiProvider'
import type { TvAgentFocus, TvFocusInfo } from './projectors'
import { TvFocus } from './TvFocus'

beforeAll(stubResizeObserver)

const mockup: TvAgentFocus = { kind: 'mockup', roomId: 'office', convId: 'c1', agent: 'Loja', cwd: 'C:\\p', path: 'C:\\p\\m\\tela.html', rel: 'm/tela.html', callId: 'call-1', waiting: 1 }
/** Um plano nas abas da TV: a conversa do Manager, o título, a pasta e o slug. */
const pl = (convId: string, title: string, slug = convId) => ({ convId, title, cwd: 'C:\\proj', slug })
const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  })
}

describe('o foco dentro da TV (TvFocus)', () => {
  it('mockup: iframe isolado (só scripts) pelo protocolo; "+1 esperando"; Aprovar manda "Aprovado: <arquivo>"', async () => {
    const send = vi.fn()
    const url = vi.fn(async () => ({ ok: true as const, url: 'agent-mockup://t/m/tela.html' }))
    render(<TvFocus info={mockup} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} onSend={send} mockupUrl={url} />)
    await flush()
    expect(url).toHaveBeenCalledWith({ cwd: 'C:\\p', path: 'C:\\p\\m\\tela.html' })
    const frame = screen.getByTestId('tv-focus-iframe')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('src')).toBe('agent-mockup://t/m/tela.html')
    expect(screen.getByText('+1 esperando')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }))
    expect(send).toHaveBeenCalledWith('c1', 'Aprovado: m/tela.html')
  })

  it('Pedir ajuste: o texto vai como "Ajustes no <arquivo>: <texto>"; vazio não manda; o arquivo que sumiu mostra o motivo', async () => {
    const send = vi.fn()
    const view = render(<TvFocus info={mockup} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} onSend={send} mockupUrl={async () => ({ ok: true, url: 'agent-mockup://t/x' })} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Pedir ajuste' }))
    expect((screen.getByRole('button', { name: 'Enviar' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Ajustes'), { target: { value: ' botão maior ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }))
    expect(send).toHaveBeenCalledWith('c1', 'Ajustes no m/tela.html: botão maior')
    view.unmount()
    render(<TvFocus info={mockup} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} mockupUrl={async () => ({ ok: false, error: 'o arquivo não existe dentro da pasta da conversa' })} />)
    await flush()
    expect(screen.getByText(/Não deu para abrir m\/tela.html/)).toBeTruthy()
    expect(screen.queryByTestId('tv-focus-reply')).toBeNull() // sem onSend, sem faixa
  })

  it('plano: a Tela de Planejamento só quando a conversa ativa é a do plano; as abas trocam de plano', () => {
    const pick = vi.fn()
    const info: TvFocusInfo = { kind: 'plan', roomId: 'office', convId: 'p1', plans: [pl('p1', 'Checkout'), pl('p2', 'Login')], waiting: 0 }
    const props = { info, projectors: { mirror: vi.fn() }, onClose: vi.fn(), onPickPlan: pick, planning: <div data-testid="planning-ws">tela</div> }
    const v = render(<TvFocus {...props} activeConvId="outra" />)
    expect(screen.queryByTestId('planning-ws')).toBeNull()
    expect(screen.getByText('Abrindo o planejamento…')).toBeTruthy()
    v.rerender(<TvFocus {...props} activeConvId="p1" />)
    expect(screen.getByTestId('planning-ws')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Checkout' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: 'Login' }))
    expect(pick).toHaveBeenCalledWith('p2')
  })

  it('plano com agente chamando: a aba "Agente chamando (N)" põe o mockup do 1º da fila no lugar do plano (Aprovar manda para ele) e só ela marca o chamado como visto; a aba do plano volta', async () => {
    const seen = vi.fn()
    const send = vi.fn()
    const test: TvAgentFocus = { kind: 'test', roomId: 'office', convId: 'c2', agent: 'Portal', url: 'http://x', title: 'Login', waiting: 0 }
    const info: TvFocusInfo = { kind: 'plan', roomId: 'office', convId: 'p1', plans: [pl('p1', 'Checkout')], waiting: 0, agents: [{ ...mockup, waiting: 0 }, test] }
    const url = async () => ({ ok: true as const, url: 'agent-mockup://t/m/tela.html' })
    render(<TvFocus info={info} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} onSend={send} mockupUrl={url} planning={<div data-testid="planning-ws">tela</div>} activeConvId="p1" onSeen={seen} />)
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    expect(screen.getByTestId('planning-ws')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Checkout' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText(/esperando/)).toBeNull()
    expect(seen).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('tab', { name: 'Agente chamando (2)' }))
    await flush()
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('mockup')
    expect(seen).toHaveBeenCalledWith('call-1')
    expect(screen.getByText('Loja · m/tela.html')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Agente chamando (2)' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'Checkout' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('tv-focus-iframe').getAttribute('src')).toBe('agent-mockup://t/m/tela.html')
    // O plano continua montado, escondido: voltar não o recarrega.
    const plan = screen.getByTestId('planning-ws')
    expect(screen.getByTestId('tv-focus-plan').hidden).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Checkout' }))
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
    expect(screen.getByTestId('tv-focus-plan').hidden).toBe(false)
    expect(screen.getByTestId('planning-ws')).toBe(plan)
    expect(screen.queryByTestId('tv-focus-iframe')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Agente chamando (2)' }))
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Aprovar' }))
    expect(send).toHaveBeenCalledWith('c1', 'Aprovado: m/tela.html')
  })

  it('plano com agente testando: a aba mostra o espelho do teste e não marca chamado nenhum; um plano só e sem fila, sem abas', () => {
    const seen = vi.fn()
    const mirror = vi.fn()
    const test: TvAgentFocus = { kind: 'test', roomId: 'office', convId: 'c2', agent: 'Portal', url: 'http://x', title: 'Login', waiting: 0 }
    const info: Extract<TvFocusInfo, { kind: 'plan' }> = { kind: 'plan', roomId: 'office', convId: 'p1', plans: [pl('p1', 'Checkout')], waiting: 0, agents: [test] }
    const v = render(<TvFocus info={info} projectors={{ mirror }} onClose={vi.fn()} activeConvId="p1" onSeen={seen} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Agente chamando (1)' }))
    expect(screen.getByTestId('tv-focus').dataset.kind).toBe('test')
    expect(mirror).toHaveBeenLastCalledWith('office', screen.getByTestId('tv-focus-mirror'))
    expect(screen.getByText('Portal · Login')).toBeTruthy()
    expect(seen).not.toHaveBeenCalled()
    v.unmount()
    render(<TvFocus info={{ ...info, agents: [] }} projectors={{ mirror }} onClose={vi.fn()} activeConvId="p1" onSeen={seen} />)
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('plano: a Tela de Planejamento de verdade (a da aba Conversa) dentro da TV — cabeçalho, chat do Manager e o "Enviar para implementação", que abre o diálogo no body, por cima do escritório', async () => {
    mockPlanningApi()
    const info: TvFocusInfo = { kind: 'plan', roomId: 'office', convId: 'p1', plans: [pl('p1', 'Plano de teste')], waiting: 0 }
    const planning = (
      <UiProvider>
        <PlanningWorkspace
          projectCwd={CWD}
          slug={SLUG}
          chat={<div data-testid="chat-slot">chat do Agent Manager</div>}
          managerModel={null}
          headerActions={<HandoffButton projectCwd={CWD} slug={SLUG} managerBusy={false} onAskManager={vi.fn()} onSend={vi.fn()} />}
        />
      </UiProvider>
    )
    try {
      render(<TvFocus info={info} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} planning={planning} activeConvId="p1" />)
      const tv = screen.getByTestId('tv-focus-plan')
      expect(tv.contains(await screen.findByRole('heading', { name: 'Plano de teste' }))).toBe(true)
      expect(tv.querySelector(':scope > .workspace.planning-workspace > .planning')).toBeTruthy()
      expect(tv.contains(screen.getByTestId('chat-slot'))).toBe(true)
      const send = screen.getByRole('button', { name: 'Enviar para implementação' }) as HTMLButtonElement
      expect(tv.contains(send)).toBe(true)
      await waitFor(() => expect(send.disabled).toBe(false))
      fireEvent.click(send)
      const dialog = screen.getByRole('dialog')
      expect(tv.contains(dialog)).toBe(false)
      expect(dialog.closest('.modal-overlay')?.parentElement).toBe(document.body)
    } finally {
      clearHandoffSession(CWD, SLUG)
    }
  })

  describe('a aba Implantação (os envios do plano para implementação)', () => {
    const plano: Extract<TvFocusInfo, { kind: 'plan' }> = { kind: 'plan', roomId: 'office', convId: 'p1', plans: [pl('p1', 'Checkout', 'checkout')], waiting: 0 }
    const center = (envios: HandoffEnvio[] | null, error: string | null = null): DeliveryCenterValue => ({
      envios,
      error,
      correct: vi.fn(async () => ({ ok: true as const, envio: envio() })),
      openConversation: vi.fn()
    })
    const tv = (c: DeliveryCenterValue, props: { onClose?: () => void; onGoToAgent?: (id: string) => boolean } = {}) =>
      render(
        <UiProvider>
          <DeliveryCenterContext.Provider value={c}>
            <TvFocus info={plano} projectors={{ mirror: vi.fn() }} onClose={props.onClose ?? vi.fn()} onGoToAgent={props.onGoToAgent} planning={<div data-testid="planning-ws">tela</div>} activeConvId="p1" />
          </DeliveryCenterContext.Provider>
        </UiProvider>
      )

    it('só com envios DO plano (o mesmo slug e a mesma pasta): o foco abre no plano e a aba traz o resumo do envio corrente, na cor do status', () => {
      tv(center([envio({ status: 'aguardando_voce', projectCwd: 'c:/PROJ/', entregas: [entrega({ status: 'concluida' }), entrega({ id: 'hn-b', etapaId: 'b', ordem: 2 })] })]))
      expect(screen.getByTestId('tv-focus').dataset.kind).toBe('plan')
      expect(screen.getByTestId('tv-focus-plan').hidden).toBe(false)
      const tab = screen.getByRole('tab', { name: 'Implantação · 1/2 · aguardando você' })
      expect([tab.getAttribute('aria-selected'), tab.classList.contains('s-aguardando_voce')]).toEqual(['false', true])
      cleanup()
      // Envios de outro plano ou de outro projeto: sem aba (um plano só e sem fila: sem abas).
      tv(center([envio({ planSlug: 'login' }), envio({ id: 'he-2', projectCwd: 'D:\\outro' })]))
      expect(screen.queryByRole('tablist')).toBeNull()
    })

    it('a aba põe o andamento no lugar do plano (que fica montado): Abrir conversa fecha a TV e abre a conversa; Ir até o agente voa até ele e, fora do escritório, avisa e abre a conversa; Marcar como concluída corrige a entrega', async () => {
      const close = vi.fn()
      const go = vi.fn(() => true)
      const c = center([envio({ conversationId: 'impl', conversationTitle: 'Implementação: checkout' })])
      tv(c, { onClose: close, onGoToAgent: go })
      const plan = screen.getByTestId('planning-ws')
      fireEvent.click(screen.getByRole('tab', { name: /^Implantação/ }))
      expect(screen.getByTestId('tv-focus-plan').hidden).toBe(true)
      expect(screen.getByText('Implantação · Checkout')).toBeTruthy()
      const row = screen.getByTestId('dlv-envio')
      fireEvent.click(within(row).getByRole('button', { name: 'Abrir conversa' }))
      expect(close).toHaveBeenCalledTimes(1)
      expect(c.openConversation).toHaveBeenLastCalledWith('impl')
      // O agente no escritório: só o voo (o motor fecha o foco).
      fireEvent.click(within(row).getByRole('button', { name: 'Ir até o agente' }))
      expect(go).toHaveBeenLastCalledWith('impl')
      expect(close).toHaveBeenCalledTimes(1)
      expect(c.openConversation).toHaveBeenCalledTimes(1)
      // Fora do escritório (filtro, conversa fechada): o aviso, a TV fecha e a conversa abre.
      go.mockReturnValue(false)
      fireEvent.click(within(row).getByRole('button', { name: 'Ir até o agente' }))
      expect(close).toHaveBeenCalledTimes(2)
      expect(c.openConversation).toHaveBeenCalledTimes(2)
      expect(await screen.findByText(/não está no escritório agora/)).toBeTruthy()
      fireEvent.click(within(row).getByRole('button', { name: /Ver as entregas/ }))
      fireEvent.click(within(row).getByRole('button', { name: 'Marcar como concluída' }))
      expect(c.correct).toHaveBeenCalledWith('hn-registro-no-banco', 'concluir')
      // O aviso de sucesso chega depois do clique: esperar por ele evita o act() solto do UiProvider.
      expect(await screen.findByText(/marcada como concluída/)).toBeTruthy()
      // De volta ao plano: o mesmo, sem recarregar.
      fireEvent.click(screen.getByRole('tab', { name: 'Checkout' }))
      expect(screen.getByTestId('tv-focus-plan').hidden).toBe(false)
      expect(screen.getByTestId('planning-ws')).toBe(plan)
      expect(screen.queryByTestId('tv-deploy')).toBeNull()
    })

    it('a aba conta pelo roteiro do plano (o resumo do planning:peek, no cache da TV) e se atualiza quando o resumo chega', async () => {
      let answer!: (r: { ok: true; plan: PlanningPeekDto }) => void
      const planningPeek = vi.fn(() => new Promise<{ ok: true; plan: PlanningPeekDto }>((resolve) => (answer = resolve)))
      const c = center([envio({ status: 'aguardando_voce', entregas: [entrega({ status: 'concluida' }), entrega({ id: 'hn-b', etapaId: 'b', ordem: 2 })] })])
      render(
        <DeliveryCenterContext.Provider value={c}>
          <TvFocus info={plano} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} activeConvId="p1" peekApi={{ planningPeek }} />
        </DeliveryCenterContext.Provider>
      )
      // Antes do resumo: as etapas enviadas.
      expect(screen.getByRole('tab', { name: 'Implantação · 1/2 · aguardando você' })).toBeTruthy()
      expect(planningPeek).toHaveBeenCalledWith({ projectCwd: 'C:\\proj', slug: 'checkout' })
      // O roteiro tem uma 3ª etapa nunca enviada: o total passa a ser o do plano.
      const etapas = ['registro-no-banco', 'b', 'deploy'].map((id) => ({ id, titulo: id, status: 'pendente' as const }))
      await act(async () => answer({ ok: true, plan: { titulo: 'Checkout', etapas, cards: 0, ambiguidadesAbertas: 0 } }))
      expect(await screen.findByRole('tab', { name: 'Implantação · 1/3 · aguardando você' })).toBeTruthy()
      expect(planningPeek).toHaveBeenCalledTimes(1)
    })

    it('sem leitura do banco: a aba aparece com o motivo, nunca "nenhum envio"; sem o centro de Entregas (o escritório fora do App), a aba não existe', () => {
      tv(center(null, 'banco fora do ar'))
      fireEvent.click(screen.getByRole('tab', { name: 'Implantação · sem leitura do banco' }))
      expect(screen.getByRole('alert').textContent).toBe('Não consegui ler as entregas do banco: banco fora do ar')
      expect(screen.queryByText(/nenhum envio/i)).toBeNull()
      cleanup()
      render(<TvFocus info={plano} projectors={{ mirror: vi.fn() }} onClose={vi.fn()} activeConvId="p1" />)
      expect(screen.queryByRole('tablist')).toBeNull()
    })
  })

  it('teste ao vivo e placar: o espelho da TV (canvas) liga na montagem e solta ao fechar; × fecha', () => {
    const mirror = vi.fn()
    const close = vi.fn()
    const v = render(<TvFocus info={{ kind: 'test', roomId: 'office', convId: 'c2', agent: 'Portal', url: 'http://x', title: 'Login', waiting: 0 }} projectors={{ mirror }} onClose={close} />)
    const canvas = screen.getByTestId('tv-focus-mirror')
    expect(mirror).toHaveBeenLastCalledWith('office', canvas)
    expect(screen.queryByText(/esperando/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fechar a TV' }))
    expect(close).toHaveBeenCalled()
    v.unmount()
    expect(mirror).toHaveBeenLastCalledWith('office', null)
    render(<TvFocus info={{ kind: 'score', roomId: 'office', waiting: 0 }} projectors={{ mirror }} onClose={close} />)
    expect(screen.getByText('Placar do escritório')).toBeTruthy()
  })
})
