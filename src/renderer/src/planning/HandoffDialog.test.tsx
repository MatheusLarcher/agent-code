import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { OpenedPlanningDto } from '@shared/ipc'
import { UiProvider } from '../ui/UiProvider'
import { HandoffButton, HandoffDialog } from './HandoffDialog'
import type { HandoffSendOutcome } from './handoffFlow'
import { buildDraftHandoff } from './handoffReadiness'
import { PlanningPlanContext } from './planningPlanContext'
import { CWD, SLUG, makeCard, makePlan, mockPlanningApi } from './planningTestUtils'

afterEach(cleanup)

function withAmbiguity(): OpenedPlanningDto {
  const plan = makePlan()
  plan.cards.push(makeCard('amb', { tipo: 'ambiguidade', etapa: 'desenho', titulo: 'Pix ou boleto?', status: 'aberta' }))
  return plan
}

const SENT: HandoffSendOutcome = { status: 'sent', delivered: 1, total: 1 }

function renderDialog(plan: OpenedPlanningDto = makePlan(), over: { managerBusy?: boolean; onSend?: () => Promise<HandoffSendOutcome> } = {}) {
  const onAskManager = vi.fn()
  const onSend = vi.fn(over.onSend ?? (async () => SENT))
  const onClose = vi.fn()
  const view = render(
    <UiProvider>
      <HandoffDialog
        projectCwd={CWD}
        slug={SLUG}
        plan={plan}
        managerBusy={over.managerBusy ?? false}
        onAskManager={onAskManager}
        onSend={onSend}
        onClose={onClose}
      />
    </UiProvider>
  )
  return { onAskManager, onSend, onClose, view }
}

const dialog = (): HTMLElement => screen.getByRole('dialog')
const button = (name: string | RegExp): HTMLButtonElement => within(dialog()).getByRole('button', { name }) as HTMLButtonElement

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

describe('HandoffDialog — conferir', () => {
  it('ambiguidade aberta bloqueia as duas saídas até marcar "enviar mesmo assim"', () => {
    mockPlanningApi()
    renderDialog(withAmbiguity())
    expect(within(screen.getByRole('region', { name: 'Bloqueios' })).getByText('Ambiguidade aberta: "Pix ou boleto?"')).toBeTruthy()
    expect(button('Pedir ao Agent Manager').disabled).toBe(true)
    expect(button('Usar rascunho automático').disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Enviar mesmo assim/))
    expect(button('Pedir ao Agent Manager').disabled).toBe(false)
    expect(button('Usar rascunho automático').disabled).toBe(false)
  })

  it('avisos não bloqueiam', () => {
    mockPlanningApi()
    renderDialog()
    const avisos = screen.getByRole('region', { name: 'Avisos' })
    expect(within(avisos).getByText('A etapa "Entregar" não tem nenhum card.')).toBeTruthy()
    expect(within(avisos).getByText('A etapa "Desenhar a solução" ainda está pendente.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Bloqueios' })).toBeNull()
    expect(button('Pedir ao Agent Manager').disabled).toBe(false)
  })

  it('Esc fecha no conferir, mas não com prompts em edição', async () => {
    mockPlanningApi()
    const { onClose } = renderDialog()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('HandoffDialog — gerar pelo Agent Manager', () => {
  it('pede pelo caminho normal e espera só arquivos NOVOS em _handoff/, relistando em planning:changed', async () => {
    const m = mockPlanningApi()
    m.addHandoff('# prompt antigo\n', Date.now() - 60_000)
    const { onAskManager } = renderDialog(makePlan(), { managerBusy: true })

    fireEvent.click(button('Pedir ao Agent Manager'))
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
    expect((screen.getByLabelText('Prompt 1') as HTMLTextAreaElement).value).toBe('# Etapa 1: backend\nfaça o backend\n')
    expect((screen.getByLabelText('Prompt 2') as HTMLTextAreaElement).value).toBe('# Etapa 2: tela\nfaça a tela\n')
    expect(within(dialog()).getByText('entra na fila')).toBeTruthy()
  })

  it('evento de outro plano não relista; cancelar volta ao conferir', async () => {
    const m = mockPlanningApi()
    renderDialog()
    fireEvent.click(button('Pedir ao Agent Manager'))
    await screen.findByText('Esperando o Agent Manager gravar o(s) prompt(s)…')
    // O texto aparece antes de o efeito do passo 'waiting' fazer a listagem
    // inicial (1ª chamada = prompts já gravados, ao abrir; 2ª = foto de antes
    // do pedido; 3ª = o efeito). Contar antes dela deixa o teste sensível à
    // carga da máquina.
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
    // A listagem ao abrir (prompts já gravados) passa; a do pedido falha.
    await waitFor(() => expect(m.api.planningListHandoffs).toHaveBeenCalledTimes(1))
    m.api.planningListHandoffs.mockResolvedValueOnce({ ok: false, code: 'io', message: 'disco cheio' } as never)
    fireEvent.click(button('Pedir ao Agent Manager'))
    expect(await screen.findByText('Não consegui listar os prompts de _handoff/: disco cheio')).toBeTruthy()
    expect(onAskManager).not.toHaveBeenCalled()
  })
})

describe('HandoffDialog — rascunho automático e envio', () => {
  it('grava o rascunho em _handoff/ e mostra para revisar', async () => {
    const m = mockPlanningApi()
    const plan = makePlan()
    renderDialog(plan)
    fireEvent.click(button('Usar rascunho automático'))
    const area = (await screen.findByLabelText('Prompt 1')) as HTMLTextAreaElement
    expect(m.api.planningWriteHandoff).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG, conteudo: buildDraftHandoff(plan) })
    expect(area.value).toBe(buildDraftHandoff(plan))
    expect(within(dialog()).getByText('2026-09-22-01.md')).toBeTruthy()
  })

  it('sem edição: envia sem gravar de novo; sucesso vira toast e fecha', async () => {
    const m = mockPlanningApi()
    const plan = makePlan()
    const { onSend, onClose } = renderDialog(plan)
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSend).toHaveBeenCalledWith([buildDraftHandoff(plan)], 'Plano de teste')
    expect(m.api.planningWriteHandoff).toHaveBeenCalledTimes(1) // só o rascunho
    expect(await screen.findByText('Plano enviado para implementação na conversa "Implementação: Plano de teste".')).toBeTruthy()
  })

  it('prompt editado é gravado como arquivo NOVO antes do envio; envia o texto final na ordem', async () => {
    const m = mockPlanningApi()
    const order: string[] = []
    m.api.planningWriteHandoff.mockImplementation(async (req: { conteudo: string }) => {
      order.push(`write:${req.conteudo}`)
      return { ok: true as const, name: m.addHandoff(req.conteudo) }
    })
    const { onSend } = renderDialog(makePlan(), {
      onSend: async () => {
        order.push('send')
        return SENT
      }
    })
    m.addHandoff('primeiro')
    m.addHandoff('segundo')
    fireEvent.click(button('Pedir ao Agent Manager'))
    await screen.findByText('Esperando o Agent Manager gravar o(s) prompt(s)…')
    // Os dois já existiam antes do pedido: não contam. O Manager grava um novo.
    m.addHandoff('do manager')
    await act(async () => m.emitChanged({ projectCwd: CWD, slug: SLUG }))
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Revisar prompt' }))

    fireEvent.change(screen.getByLabelText('Prompt 1'), { target: { value: 'do manager, revisado' } })
    expect(within(dialog()).getByText('editado')).toBeTruthy()
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(onSend).toHaveBeenCalledWith(['do manager, revisado'], 'Plano de teste')
    expect(order).toEqual(['write:do manager, revisado', 'send'])
    expect(m.handoffs.map((h) => h.content)).toEqual(['primeiro', 'segundo', 'do manager', 'do manager, revisado'])
  })

  it('falha ao gravar o editado: toast e nada é enviado', async () => {
    const m = mockPlanningApi()
    const { onSend } = renderDialog()
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    m.api.planningWriteHandoff.mockResolvedValueOnce({ ok: false, code: 'io', message: 'EACCES' } as never)
    fireEvent.change(screen.getByLabelText('Prompt 1'), { target: { value: 'outro texto' } })
    fireEvent.click(button('Enviar para implementação'))
    expect(await screen.findByText(/Não consegui gravar o prompt editado \(2026-09-22-01\.md\): EACCES\. Nada foi enviado\./)).toBeTruthy()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('prompt vazio não é enviado', async () => {
    mockPlanningApi()
    renderDialog()
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.change(screen.getByLabelText('Prompt 1'), { target: { value: '   ' } })
    expect(button('Enviar para implementação').disabled).toBe(true)
  })

  it('conversa criada mas envio falhou: fecha (não deixa criar outra) e o toast manda usar "Tentar de novo"', async () => {
    mockPlanningApi()
    const { onSend, onClose } = renderDialog(makePlan(), {
      onSend: async () => ({ status: 'created-failed', delivered: 0, total: 1 })
    })
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.click(button('Enviar para implementação'))
    expect(await screen.findByText(/"Implementação: Plano de teste" foi criada[\s\S]*"Tentar de novo"/)).toBeTruthy()
    expect(screen.getByText(/criaria outra conversa/)).toBeTruthy()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('nada criado: toast e o diálogo continua para tentar de novo', async () => {
    mockPlanningApi()
    const { onClose } = renderDialog(makePlan(), { onSend: async () => ({ status: 'not-created', delivered: 0, total: 0 }) })
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.click(button('Enviar para implementação'))
    expect(await screen.findByText(/Nada foi enviado para a implementação/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
    expect(button('Enviar para implementação').disabled).toBe(false)
  })

  it('tentar de novo não regrava em _handoff/ o prompt editado que já foi gravado', async () => {
    const m = mockPlanningApi()
    let attempt = 0
    const { onSend, onClose } = renderDialog(makePlan(), {
      onSend: async () => {
        // 1ª tentativa: a conversa nem chegou a ser criada (erro antes do create).
        if (attempt++ === 0) throw new Error('falhou antes de criar')
        return SENT
      }
    })
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.change(screen.getByLabelText('Prompt 1'), { target: { value: 'editado uma vez' } })
    fireEvent.click(button('Enviar para implementação'))
    expect(await screen.findByText(/Não consegui enviar para a implementação: falhou antes de criar/)).toBeTruthy()
    // rascunho + o editado
    expect(m.api.planningWriteHandoff).toHaveBeenCalledTimes(2)
    // O prompt agora aponta para o arquivo com o texto editado.
    expect(within(dialog()).getByText('2026-09-22-02.md')).toBeTruthy()

    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(m.api.planningWriteHandoff).toHaveBeenCalledTimes(2) // nada regravado
    expect(onSend).toHaveBeenLastCalledWith(['editado uma vez'], 'Plano de teste')
  })
})

describe('HandoffDialog — prompts já gerados (depois de reiniciar o app)', () => {
  it('mostra o último lote gravado em _handoff/ e deixa revisar e enviar sem pedir de novo', async () => {
    const m = mockPlanningApi()
    const now = Date.now()
    m.handoffs.push(
      { name: '2026-09-22-01.md', createdAt: now, content: '# Handoff 1 de 2\nparte um' },
      { name: '2026-09-22-02.md', createdAt: now + 1000, content: '# Handoff 2 de 2\nparte dois' }
    )
    const { onAskManager, onSend } = renderDialog()
    expect(await screen.findByText('2 prompts já gerados')).toBeTruthy()
    fireEvent.click(button('Revisar estes prompts'))
    expect((screen.getByLabelText('Prompt 1') as HTMLTextAreaElement).value).toContain('parte um')
    expect((screen.getByLabelText('Prompt 2') as HTMLTextAreaElement).value).toContain('parte dois')
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect((onSend.mock.calls[0] as unknown[])[0]).toEqual(['# Handoff 1 de 2\nparte um', '# Handoff 2 de 2\nparte dois'])
    expect(onAskManager).not.toHaveBeenCalled()
  })

  it('sem nada gravado, a seção não aparece', async () => {
    const m = mockPlanningApi()
    renderDialog()
    await waitFor(() => expect(m.api.planningListHandoffs).toHaveBeenCalled())
    expect(screen.queryByText(/já gerado/)).toBeNull()
  })
})
