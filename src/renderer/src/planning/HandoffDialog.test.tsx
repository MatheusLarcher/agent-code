import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { UiProvider } from '../ui/UiProvider'
import { HandoffButton, HandoffDialog } from './HandoffDialog'
import { clearHandoffSession } from './handoffFlow'
import { CONV, SENT, area, button, dialog, loaded, renderDialog, withAmbiguity } from './handoffDialogTestUtils'
import { PlanningPlanContext } from './planningPlanContext'
import { CWD, SLUG, makePlan, mockPlanningApi } from './planningTestUtils'

afterEach(() => {
  cleanup()
  clearHandoffSession(CWD, SLUG)
})

describe('HandoffButton', () => {
  it('sem plano carregado fica desabilitado; com plano abre o diálogo', () => {
    mockPlanningApi()
    const actions = { projectCwd: CWD, slug: SLUG, managerBusy: false, onAskManager: vi.fn(), onSend: vi.fn(async () => SENT) }
    const { rerender } = render(
      <UiProvider>
        <PlanningPlanContext.Provider value={null}>
          <HandoffButton {...actions} />
        </PlanningPlanContext.Provider>
      </UiProvider>
    )
    const btn = screen.getByRole('button', { name: 'Enviar para implementação' }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    rerender(
      <UiProvider>
        <PlanningPlanContext.Provider value={makePlan()}>
          <HandoffButton {...actions} />
        </PlanningPlanContext.Provider>
      </UiProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para implementação' }))
    expect(within(dialog()).getByRole('heading', { name: 'Enviar para implementação' })).toBeTruthy()
  })
})

describe('HandoffDialog — conferir (sem prompts a enviar)', () => {
  it('ambiguidade aberta bloqueia as duas saídas até marcar "enviar mesmo assim"', async () => {
    mockPlanningApi()
    renderDialog(withAmbiguity())
    await loaded()
    expect(within(screen.getByRole('region', { name: 'Bloqueios' })).getByText('Ambiguidade aberta: "Pix ou boleto?"')).toBeTruthy()
    expect(button('Pedir ao Agent Manager').disabled).toBe(true)
    expect(button('Usar rascunho automático').disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Enviar mesmo assim/))
    expect(button('Pedir ao Agent Manager').disabled).toBe(false)
    expect(button('Usar rascunho automático').disabled).toBe(false)
  })

  it('avisos não bloqueiam', async () => {
    mockPlanningApi()
    renderDialog()
    await loaded()
    const avisos = screen.getByRole('region', { name: 'Avisos' })
    expect(within(avisos).getByText('A etapa "Entregar" não tem nenhum card.')).toBeTruthy()
    expect(within(avisos).getByText('A etapa "Desenhar a solução" ainda está pendente.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Bloqueios' })).toBeNull()
    expect(button('Pedir ao Agent Manager').disabled).toBe(false)
  })

  it('Esc e clique fora fecham; reaberto, volta aos prompts em edição', async () => {
    mockPlanningApi()
    const { onClose, view } = renderDialog()
    await loaded()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(button('Usar rascunho automático'))
    fireEvent.change(await screen.findByLabelText('Prompt 1'), { target: { value: 'editado' } })
    fireEvent.mouseDown(dialog())
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(document.querySelector('.pl-handoff-overlay') as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(2)
    view.unmount()
    renderDialog()
    expect(area(1).value).toBe('editado')
  })

  it('com o Agent Manager num turno, o conferir mostra que ele está trabalhando', async () => {
    mockPlanningApi()
    renderDialog(makePlan(), { managerBusy: true })
    await loaded()
    expect(screen.getByText('O Agent Manager está trabalhando.')).toBeTruthy()
  })

  it('lista os enviados com data e título; "Abrir conversa" ativa a conversa, apagada fica sem link', async () => {
    const m = mockPlanningApi()
    m.handoffs.push({ name: '2026-09-22-01.md', createdAt: 0, content: '# a' }, { name: '2026-09-22-02.md', createdAt: 0, content: '# b' })
    m.sent.push(
      { nome: '2026-09-22-01.md', enviadoEm: '2026-09-22T12:00:00.000Z', conversaId: 'viva', conversaTitulo: 'Implementação: Viva' },
      { nome: '2026-09-22-02.md', enviadoEm: '2026-09-22T12:00:00.000Z', conversaId: 'morta', conversaTitulo: 'Implementação: Morta' }
    )
    const { onClose, onOpenConversation } = renderDialog(makePlan(), { conversationExists: (id) => id === 'viva' })
    await loaded()
    const enviados = screen.getByRole('region', { name: 'Prompts enviados' })
    expect(within(enviados).getByText('2 prompts enviados')).toBeTruthy()
    expect(within(enviados).getByText('Implementação: Viva')).toBeTruthy()
    expect(within(enviados).getByText('conversa apagada')).toBeTruthy()
    expect(within(enviados).getAllByRole('button', { name: 'Abrir conversa' })).toHaveLength(1)
    // Sem pendentes: o principal volta a ser pedir ao Manager.
    expect(button('Pedir ao Agent Manager')).toBeTruthy()
    fireEvent.click(within(enviados).getByRole('button', { name: 'Abrir conversa' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpenConversation).toHaveBeenCalledWith('viva')
  })
})

describe('HandoffDialog — abertura direta nos prompts a enviar', () => {
  it('no StrictMode (o app usa), o prompt a enviar abre direto na revisão', async () => {
    mockPlanningApi().addHandoff('# Prompt salvo')
    render(
      <StrictMode>
        <UiProvider>
          <HandoffDialog projectCwd={CWD} slug={SLUG} plan={makePlan()} managerBusy={false} onAskManager={vi.fn()} onSend={vi.fn(async () => SENT)} onClose={vi.fn()} />
        </UiProvider>
      </StrictMode>
    )
    expect(((await screen.findByLabelText('Prompt 1')) as HTMLTextAreaElement).value).toBe('# Prompt salvo')
  })

  it('dois prompts gravados com horas de distância: um clique cria a conversa e registra os dois', async () => {
    const m = mockPlanningApi()
    const now = Date.now()
    m.handoffs.push(
      { name: '2026-09-22-01.md', createdAt: now - 3 * 3_600_000, content: '# Handoff 1 de 2\nparte um' },
      { name: '2026-09-22-02.md', createdAt: now, content: '# Handoff 2 de 2\nparte dois' }
    )
    const { onAskManager, onSend, view } = renderDialog(makePlan(), {
      onSend: async () => ({ status: 'sent', delivered: 2, total: 2, conversation: CONV })
    })
    expect(((await screen.findByLabelText('Prompt 1')) as HTMLTextAreaElement).value).toContain('parte um')
    expect(area(2).value).toContain('parte dois')
    expect(within(dialog()).getByText('entra na fila')).toBeTruthy()
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(m.sent).toHaveLength(2))
    expect(onSend).toHaveBeenCalledWith(
      ['# Handoff 1 de 2\nparte um', '# Handoff 2 de 2\nparte dois'],
      'Plano de teste',
      ['2026-09-22-01.md', '2026-09-22-02.md']
    )
    expect(onAskManager).not.toHaveBeenCalled()
    expect(m.sent.map((e) => [e.nome, e.conversaId])).toEqual([
      ['2026-09-22-01.md', 'conv-1'],
      ['2026-09-22-02.md', 'conv-1']
    ])
    // Reaberto: nada a enviar, os dois aparecem com "Abrir conversa".
    view.unmount()
    renderDialog()
    await loaded()
    const enviados = screen.getByRole('region', { name: 'Prompts enviados' })
    expect(within(enviados).getAllByRole('button', { name: 'Abrir conversa' })).toHaveLength(2)
  })

  it('com prompts a enviar, nenhum botão principal pede ao Agent Manager', async () => {
    const m = mockPlanningApi()
    m.addHandoff('# pronto')
    const { onAskManager } = renderDialog()
    await screen.findByLabelText('Prompt 1')
    expect(within(dialog()).getByRole('button', { name: 'Enviar para implementação' }).className).toContain('primary')
    fireEvent.click(button('Conferir o plano'))
    expect(within(dialog()).queryByRole('button', { name: 'Pedir ao Agent Manager' })).toBeNull()
    expect(button('Revisar prompt').className).toContain('primary')
    expect(button('Gerar de novo com o Agent Manager').className).not.toContain('primary')
    expect(onAskManager).not.toHaveBeenCalled()
    // Voltar à revisão retoma os mesmos prompts.
    fireEvent.click(button('Revisar prompt'))
    expect(area(1).value).toBe('# pronto')
  })

  it('ambiguidade aberta bloqueia o envio também na abertura direta', async () => {
    const m = mockPlanningApi()
    m.addHandoff('# pronto')
    const { onSend } = renderDialog(withAmbiguity())
    await screen.findByLabelText('Prompt 1')
    expect(screen.getByRole('region', { name: 'Bloqueios' })).toBeTruthy()
    expect(button('Enviar para implementação').disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Enviar mesmo assim/))
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
  })

  it('"Marcar como já enviado" persiste: todos marcados, volta a Conferir e os lista como marcados à mão', async () => {
    const m = mockPlanningApi()
    for (const c of ['# um', '# dois', '# três']) m.addHandoff(c)
    const { view } = renderDialog()
    await screen.findByLabelText('Prompt 3')
    for (let i = 0; i < 3; i++) {
      fireEvent.click(within(dialog()).getAllByRole('button', { name: 'Marcar como já enviado' })[0])
      await waitFor(() => expect(m.sent).toHaveLength(i + 1))
    }
    await waitFor(() => expect(button('Pedir ao Agent Manager')).toBeTruthy())
    expect(m.sent.every((e) => e.marcadoManualmente === true)).toBe(true)
    expect(within(screen.getByRole('region', { name: 'Prompts enviados' })).getAllByText('marcado como já enviado')).toHaveLength(3)
    // Reiniciar o app (sem sessão): abre em Conferir, sem nada a enviar.
    view.unmount()
    clearHandoffSession(CWD, SLUG)
    renderDialog()
    await loaded()
    expect(screen.queryByLabelText('Prompt 1')).toBeNull()
    expect(screen.queryByRole('region', { name: 'Prompts a enviar' })).toBeNull()
  })

  it('"Tirar deste envio" não persiste: sai da revisão, dá para incluir de novo, e volta depois de reiniciar', async () => {
    const m = mockPlanningApi()
    m.addHandoff('# um')
    m.addHandoff('# dois')
    const { view } = renderDialog()
    await screen.findByLabelText('Prompt 2')
    fireEvent.click(within(dialog()).getAllByRole('button', { name: 'Tirar deste envio' })[0])
    expect(area(1).value).toBe('# dois')
    expect(screen.queryByLabelText('Prompt 2')).toBeNull()
    const fora = screen.getByRole('region', { name: 'Fora deste envio' })
    expect(within(fora).getByText('_handoff/2026-09-22-01.md')).toBeTruthy()
    expect(m.api.planningMarkHandoffsSent).not.toHaveBeenCalled()

    view.unmount()
    clearHandoffSession(CWD, SLUG)
    const { onSend } = renderDialog()
    expect(((await screen.findByLabelText('Prompt 2')) as HTMLTextAreaElement).value).toBe('# dois')
    fireEvent.click(within(dialog()).getAllByRole('button', { name: 'Tirar deste envio' })[0])
    fireEvent.click(within(screen.getByRole('region', { name: 'Fora deste envio' })).getByRole('button', { name: 'Incluir' }))
    expect(area(2).value).toBe('# um')
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect((onSend.mock.calls[0] as unknown[])[2]).toEqual(['2026-09-22-02.md', '2026-09-22-01.md'])
  })

  it('enviados.json ilegível: avisa e todos contam como a enviar', async () => {
    const m = mockPlanningApi()
    m.addHandoff('# um')
    m.api.planningListHandoffs.mockResolvedValue({ ok: true, handoffs: structuredClone(m.handoffs), sent: [], sentError: 'enviados.json não é JSON válido (x)' })
    renderDialog()
    expect(((await screen.findByLabelText('Prompt 1')) as HTMLTextAreaElement).value).toBe('# um')
    expect(await screen.findByText(/Ignorei _handoff\/enviados\.json não é JSON válido/)).toBeTruthy()
  })
})

describe('HandoffDialog — gerar pelo Agent Manager', () => {
  it('pede pelo caminho normal e espera só arquivos NOVOS em _handoff/, relistando em planning:changed', async () => {
    const m = mockPlanningApi()
    m.addHandoff('# prompt antigo\n', Date.now() - 60_000)
    const { onAskManager } = renderDialog(makePlan(), { managerBusy: true })
    await screen.findByLabelText('Prompt 1') // o antigo está a enviar: abre direto

    fireEvent.click(button('Gerar de novo com o Agent Manager'))
    await screen.findByText('Esperando o Agent Manager gravar o(s) prompt(s)…')
    expect(onAskManager).toHaveBeenCalledTimes(1)
    expect(onAskManager.mock.calls[0][0]).toContain('mcp__planning__plan_handoff_write')
    expect(button('Revisar prompt').disabled).toBe(true)

    // O Manager grava dois prompts; plan_handoff_write avisa planning:changed.
    m.addHandoff('# Etapa 1: backend\nfaça o backend\n')
    m.addHandoff('# Etapa 2: tela\nfaça a tela\n')
    await act(async () => m.emitChanged({ projectCwd: CWD, slug: SLUG }))
    expect(await screen.findByText('2 prompts novos em _handoff/')).toBeTruthy()
    expect(screen.queryByText('_handoff/2026-09-22-01.md')).toBeNull() // o antigo não conta
    expect(screen.getByText('_handoff/2026-09-22-02.md')).toBeTruthy()
    expect(screen.getByText('Etapa 1: backend')).toBeTruthy()

    fireEvent.click(button('Revisar 2 prompts'))
    expect(area(1).value).toBe('# Etapa 1: backend\nfaça o backend\n')
    expect(area(2).value).toBe('# Etapa 2: tela\nfaça a tela\n')
    // O antigo continua a enviar, fora desta revisão.
    expect(within(screen.getByRole('region', { name: 'Fora deste envio' })).getByText('_handoff/2026-09-22-01.md')).toBeTruthy()
  })

  it('evento de outro plano não relista; cancelar volta ao conferir', async () => {
    const m = mockPlanningApi()
    renderDialog()
    await loaded()
    fireEvent.click(button('Pedir ao Agent Manager'))
    await screen.findByText('Esperando o Agent Manager gravar o(s) prompt(s)…')
    // 1ª chamada = ao abrir; 2ª = foto de antes do pedido; 3ª = o efeito do passo.
    await waitFor(() => expect(m.api.planningListHandoffs).toHaveBeenCalledTimes(3))
    const calls = m.api.planningListHandoffs.mock.calls.length
    await act(async () => m.emitChanged({ projectCwd: CWD, slug: 'outro' }))
    expect(m.api.planningListHandoffs.mock.calls.length).toBe(calls)
    fireEvent.click(button('Cancelar'))
    expect(button('Pedir ao Agent Manager')).toBeTruthy()
  })

  it('com "enviar mesmo assim", o pedido avisa o Manager das ambiguidades abertas', async () => {
    mockPlanningApi()
    const { onAskManager } = renderDialog(withAmbiguity())
    await loaded()
    fireEvent.click(screen.getByLabelText(/Enviar mesmo assim/))
    fireEvent.click(button('Pedir ao Agent Manager'))
    await waitFor(() => expect(onAskManager).toHaveBeenCalled())
    expect(onAskManager.mock.calls[0][0]).toMatch(/Uma ambiguidade continua aberta/)
  })

  it('plano com mídia: o pedido exige caminho absoluto + tipo; anexo sumido é aviso, não bloqueio', async () => {
    mockPlanningApi()
    const plan = makePlan({
      media: [{ name: 'a1-tela.png', path: 'D:\\x\\midia\\a1-tela.png', kind: 'imagem', size: 1, mediaType: 'image/png' }]
    })
    plan.cards[0] = { ...plan.cards[0], anexos: ['a1-tela.png', 'b2-sumiu.pdf'] }
    const { onAskManager } = renderDialog(plan)
    await loaded()
    const avisos = screen.getByRole('region', { name: 'Avisos' })
    expect(within(avisos).getByText(/cita o anexo "b2-sumiu\.pdf"/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Bloqueios' })).toBeNull()
    fireEvent.click(button('Pedir ao Agent Manager'))
    await waitFor(() => expect(onAskManager).toHaveBeenCalled())
    expect(onAskManager.mock.calls[0][0]).toContain('o plano tem uma mídia em midia/')
    expect(onAskManager.mock.calls[0][0]).toMatch(/CAMINHO ABSOLUTO e o TIPO/)
  })

  it('falha ao listar _handoff/ vira toast e não pede nada', async () => {
    const m = mockPlanningApi()
    const { onAskManager } = renderDialog()
    await loaded()
    m.api.planningListHandoffs.mockResolvedValueOnce({ ok: false, code: 'io', message: 'disco cheio' } as never)
    fireEvent.click(button('Pedir ao Agent Manager'))
    expect(await screen.findByText('Não consegui listar os prompts de _handoff/: disco cheio')).toBeTruthy()
    expect(onAskManager).not.toHaveBeenCalled()
  })

  it('falha na 1ª listagem: abre em Conferir, sem travar no "lendo"', async () => {
    const m = mockPlanningApi()
    m.api.planningListHandoffs.mockResolvedValueOnce({ ok: false, code: 'io', message: 'x' } as never)
    renderDialog()
    await loaded()
    expect(button('Pedir ao Agent Manager')).toBeTruthy()
  })
})

