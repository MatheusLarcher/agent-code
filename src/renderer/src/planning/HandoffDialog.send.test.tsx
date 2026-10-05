import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { clearHandoffSession } from './handoffFlow'
import { buildDraftHandoff } from './handoffReadiness'
import { CONV, SENT, area, button, dialog, loaded, renderDialog } from './handoffDialogTestUtils'
import { CWD, SLUG, makePlan, mockPlanningApi } from './planningTestUtils'

afterEach(() => {
  cleanup()
  clearHandoffSession(CWD, SLUG)
})

describe('HandoffDialog — rascunho automático e envio', () => {
  it('grava o rascunho em _handoff/ com TODAS as etapas do roteiro e mostra para revisar', async () => {
    const m = mockPlanningApi()
    const plan = makePlan()
    renderDialog(plan)
    await loaded()
    fireEvent.click(button('Usar rascunho automático'))
    expect(((await screen.findByLabelText('Prompt 1')) as HTMLTextAreaElement).value).toBe(buildDraftHandoff(plan))
    expect(m.api.planningWriteHandoff).toHaveBeenCalledWith({
      projectCwd: CWD,
      slug: SLUG,
      conteudo: buildDraftHandoff(plan),
      etapas: ['requisitos', 'desenho', 'entrega']
    })
    expect(within(dialog()).getByText('2026-09-22-01.md')).toBeTruthy()
    // O roteiro de teste não tem estimativas: as 3 etapas aparecem, sem total.
    expect(screen.getByTestId('estimativa-1').textContent).toBe('3 etapas, nenhuma com estimativa')
  })

  it('sem edição: envia sem gravar de novo, registra o envio; sucesso vira toast e fecha', async () => {
    const m = mockPlanningApi()
    const plan = makePlan()
    const { onSend, onClose } = renderDialog(plan)
    await loaded()
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSend).toHaveBeenCalledWith([buildDraftHandoff(plan)], 'Plano de teste', ['2026-09-22-01.md'])
    expect(m.api.planningWriteHandoff).toHaveBeenCalledTimes(1) // só o rascunho
    expect(m.sent).toEqual([
      { nome: '2026-09-22-01.md', enviadoEm: expect.any(String), conversaId: 'conv-1', conversaTitulo: CONV.title }
    ])
    expect(await screen.findByText('Plano enviado para implementação na conversa "Implementação: Plano de teste".')).toBeTruthy()
  })

  it('prompt editado vira arquivo NOVO antes do envio: o novo é registrado e o original fica substituído', async () => {
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
    await loaded()
    m.addHandoff('do manager') // -01
    await act(async () => m.emitChanged({ projectCwd: CWD, slug: SLUG }))
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Revisar prompt' }))
    fireEvent.change(area(1), { target: { value: 'do manager, revisado' } })
    expect(within(dialog()).getByText('editado')).toBeTruthy()
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(m.sent).toHaveLength(2))
    expect(onSend).toHaveBeenCalledWith(['do manager, revisado'], 'Plano de teste', ['2026-09-22-02.md'])
    expect(order).toEqual(['write:do manager, revisado', 'send'])
    // A original não declarou etapas: o editado também não.
    expect(m.api.planningWriteHandoff).toHaveBeenCalledWith({ projectCwd: CWD, slug: SLUG, conteudo: 'do manager, revisado' })
    expect(m.sent).toEqual([
      { nome: '2026-09-22-01.md', enviadoEm: expect.any(String), substituidoPor: '2026-09-22-02.md' },
      { nome: '2026-09-22-02.md', enviadoEm: expect.any(String), conversaId: 'conv-1', conversaTitulo: CONV.title }
    ])
  })

  it('cada prompt mostra o total estimado das etapas dele (roteiro atual) ou "sem etapas declaradas"', async () => {
    const plan = makePlan()
    plan.roteiro.etapas = [
      { id: 'requisitos', titulo: 'Levantar requisitos', status: 'concluida', estimativa: 30 },
      { id: 'desenho', titulo: 'Desenhar a solução', status: 'pendente', estimativa: 60 },
      { id: 'entrega', titulo: 'Entregar', status: 'em_andamento' }
    ]
    const m = mockPlanningApi(plan)
    m.addHandoff('# um')
    m.addHandoff('# dois')
    m.addHandoff('# antigo')
    m.handoffs[0].etapas = ['requisitos', 'desenho']
    m.handoffs[1].etapas = ['entrega', 'desenho']
    renderDialog(plan)
    await screen.findByLabelText('Prompt 3')
    expect(screen.getByTestId('estimativa-1').textContent).toBe('Total estimado: 1 h 30 min · 2 etapas')
    expect(screen.getByTestId('estimativa-1').title).toBe('Levantar requisitos: 30 min\nDesenhar a solução: 1 h')
    expect(screen.getByTestId('estimativa-2').textContent).toBe('Total estimado: 1 h · 2 etapas, 1 sem estimativa')
    expect(screen.getByTestId('estimativa-3').textContent).toBe('sem etapas declaradas')
  })

  it('a versão editada é gravada com as etapas da original e continua mostrando o total', async () => {
    const plan = makePlan()
    plan.roteiro.etapas[1] = { ...plan.roteiro.etapas[1], estimativa: 45 }
    const m = mockPlanningApi(plan)
    m.addHandoff('# do manager')
    m.handoffs[0].etapas = ['desenho']
    const { onSend } = renderDialog(plan)
    await screen.findByLabelText('Prompt 1')
    fireEvent.change(area(1), { target: { value: '# do manager, revisado' } })
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(m.api.planningWriteHandoff).toHaveBeenCalledWith({
      projectCwd: CWD,
      slug: SLUG,
      conteudo: '# do manager, revisado',
      etapas: ['desenho']
    })
    expect(onSend).toHaveBeenCalledWith(['# do manager, revisado'], 'Plano de teste', ['2026-09-22-02.md'])
  })

  it('o editado que falhou no envio fica na revisão com as etapas herdadas (o total não some)', async () => {
    const plan = makePlan()
    plan.roteiro.etapas[0] = { ...plan.roteiro.etapas[0], estimativa: 20 }
    const m = mockPlanningApi(plan)
    m.addHandoff('# original')
    m.handoffs[0].etapas = ['requisitos']
    renderDialog(plan, { onSend: async () => ({ status: 'not-created', delivered: 0, total: 0 }) })
    await screen.findByLabelText('Prompt 1')
    fireEvent.change(area(1), { target: { value: '# editado' } })
    fireEvent.click(button('Enviar para implementação'))
    expect(await screen.findByText(/Nada foi enviado para a implementação/)).toBeTruthy()
    expect(within(dialog()).getByText('2026-09-22-02.md')).toBeTruthy()
    expect(screen.getByTestId('estimativa-1').textContent).toBe('Total estimado: 20 min · 1 etapa')
  })

  it('falha ao gravar o editado: toast e nada é enviado', async () => {
    const m = mockPlanningApi()
    const { onSend } = renderDialog()
    await loaded()
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    m.api.planningWriteHandoff.mockResolvedValueOnce({ ok: false, code: 'io', message: 'EACCES' } as never)
    fireEvent.change(area(1), { target: { value: 'outro texto' } })
    fireEvent.click(button('Enviar para implementação'))
    expect(await screen.findByText(/Não consegui gravar o prompt editado \(2026-09-22-01\.md\): EACCES\. Nada foi enviado\./)).toBeTruthy()
    expect(onSend).not.toHaveBeenCalled()
    expect(m.sent).toEqual([])
  })

  it('prompt vazio não é enviado', async () => {
    mockPlanningApi()
    renderDialog()
    await loaded()
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.change(area(1), { target: { value: '   ' } })
    expect(button('Enviar para implementação').disabled).toBe(true)
  })

  it('conversa criada mas envio falhou: fecha (não deixa criar outra) e o toast manda usar "Tentar de novo"', async () => {
    const m = mockPlanningApi()
    const { onSend, onClose } = renderDialog(makePlan(), {
      onSend: async () => ({ status: 'created-failed', delivered: 0, total: 1, conversation: CONV })
    })
    await loaded()
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.click(button('Enviar para implementação'))
    expect(await screen.findByText(/"Implementação: Plano de teste" foi criada[\s\S]*"Tentar de novo"/)).toBeTruthy()
    expect(screen.getByText(/criaria outra conversa/)).toBeTruthy()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(m.api.planningMarkHandoffsSent).not.toHaveBeenCalled() // nada entregue, nada registrado
  })

  it('envio parcial: só os prompts entregues ficam registrados; o resto continua a enviar', async () => {
    const m = mockPlanningApi()
    for (const c of ['# um', '# dois', '# três']) m.addHandoff(c)
    const { onClose } = renderDialog(makePlan(), {
      onSend: async () => ({ status: 'created-failed', delivered: 1, total: 3, conversation: CONV })
    })
    await screen.findByLabelText('Prompt 3')
    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    await waitFor(() => expect(m.sent).toHaveLength(1))
    expect(m.sent[0]).toMatchObject({ nome: '2026-09-22-01.md', conversaId: 'conv-1' })
    cleanup()
    renderDialog()
    expect(((await screen.findByLabelText('Prompt 1')) as HTMLTextAreaElement).value).toBe('# dois')
    expect(area(2).value).toBe('# três')
  })

  it('nada criado: toast e o diálogo continua para tentar de novo', async () => {
    mockPlanningApi()
    const { onClose } = renderDialog(makePlan(), { onSend: async () => ({ status: 'not-created', delivered: 0, total: 0 }) })
    await loaded()
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
    await loaded()
    fireEvent.click(button('Usar rascunho automático'))
    await screen.findByLabelText('Prompt 1')
    fireEvent.change(area(1), { target: { value: 'editado uma vez' } })
    fireEvent.click(button('Enviar para implementação'))
    expect(await screen.findByText(/Não consegui enviar para a implementação: falhou antes de criar/)).toBeTruthy()
    // rascunho + o editado
    expect(m.api.planningWriteHandoff).toHaveBeenCalledTimes(2)
    // O prompt agora aponta para o arquivo com o texto editado.
    expect(within(dialog()).getByText('2026-09-22-02.md')).toBeTruthy()

    fireEvent.click(button('Enviar para implementação'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(m.api.planningWriteHandoff).toHaveBeenCalledTimes(2) // nada regravado
    expect(onSend).toHaveBeenLastCalledWith(['editado uma vez'], 'Plano de teste', ['2026-09-22-02.md'])
  })

  it('"Marcar como já enviado" não perde o que foi digitado enquanto grava', async () => {
    const m = mockPlanningApi()
    m.addHandoff('# um')
    m.addHandoff('# dois')
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const real = m.api.planningMarkHandoffsSent.getMockImplementation()!
    m.api.planningMarkHandoffsSent.mockImplementationOnce(async (req) => {
      await gate
      return real(req)
    })
    renderDialog()
    await screen.findByLabelText('Prompt 2')
    fireEvent.click(within(dialog()).getAllByRole('button', { name: 'Marcar como já enviado' })[0])
    fireEvent.change(area(2), { target: { value: '# dois, digitado durante a gravação' } })
    await act(async () => release())
    await waitFor(() => expect(screen.queryByLabelText('Prompt 2')).toBeNull())
    expect(area(1).value).toBe('# dois, digitado durante a gravação')
  })
})
