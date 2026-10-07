import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HandoffProjectFolder, HandoffProjectPlan, HandoffProjectSnapshot } from '@shared/handoffProject'
import type { HandoffQueueItem } from '@shared/handoffTracking'
import { ChatQueueNotice } from './ChatQueueNotice'
import { NextPromptsStrip, type NextPromptsStripApi } from './NextPromptsStrip'
import { chatQueueNotice, fmtMinutes, moveBefore, nextPlans, promptText } from './nextPrompts'

/**
 * A faixa "Próximos prompts": agrupada por plano, com o texto e o estado de
 * cada prompt; arrastar reordena (planos inteiros, ou prompts DENTRO do
 * plano); Ver/editar, Tirar da fila, Enviar mesmo assim, Começar mesmo assim e
 * Passar a vez. E o aviso no chat da implantação.
 */

afterEach(cleanup)

const CWD = 'C:\\proj'

const item = (over: Partial<HandoffQueueItem>): HandoffQueueItem => ({
  envioId: 'e2',
  conversationId: 'conv-a',
  conversationTitle: 'Implementação: Plano A',
  projectCwd: CWD,
  planSlug: 'a',
  planTitulo: 'Plano A',
  loteId: 'la',
  ordem: 2,
  arquivo: '02.md',
  estado: 'esperando',
  motivo: null,
  estimativaTotal: 40,
  etapas: [{ id: 'x', titulo: 'Fazer X' }],
  totalPrompts: 3,
  conteudo: 'Texto do prompt 2',
  ...over
})

const plan = (over: Partial<HandoffProjectPlan>): HandoffProjectPlan => ({
  loteId: 'la',
  conversationId: 'conv-a',
  planTitulo: 'Plano A',
  posicao: 1,
  estado: 'rodando',
  comecou: true,
  comecarMesmoAssim: null,
  arquivosDoAnterior: [],
  sujo: null,
  restanteMin: null,
  ...over
})

const snap = (plans: HandoffProjectPlan[], over: Partial<HandoffProjectFolder> = {}): HandoffProjectSnapshot => ({
  caseInsensitive: true,
  folders: [{ key: 'c:/proj', cwd: CWD, plans, implantacaoEmCurso: true, avaliacao: null, avaliando: null, resposta: null, ...over }]
})

// Dois planos: A (com a vez, parado) com os prompts 2 e 3; B esperando, com o prompt 1.
const items: HandoffQueueItem[] = [
  item({ envioId: 'a2', ordem: 2, planPosicao: 1, estado: 'parada', motivo: 'o prompt anterior não foi concluído' }),
  item({ envioId: 'a3', ordem: 3, planPosicao: 1, conteudo: 'Texto do prompt 3', etapas: [] }),
  item({
    envioId: 'b1',
    conversationId: 'conv-b',
    conversationTitle: 'Implementação: Plano B',
    planSlug: 'b',
    planTitulo: 'Plano B',
    loteId: 'lb',
    ordem: 1,
    planPosicao: 2,
    estimativaTotal: 90,
    totalPrompts: 1,
    motivo: 'na fila do projeto (2º): esperando o plano "Plano A" terminar'
  })
]
const twoPlans = snap([plan({ estado: 'parado' }), plan({ loteId: 'lb', conversationId: 'conv-b', planTitulo: 'Plano B', posicao: 2, estado: 'na_fila', comecou: false })])

function fakeApi(list = items, snapshot = twoPlans) {
  return {
    handoffQueueList: vi.fn(async () => ({ ok: true as const, items: list })),
    handoffProjectStatus: vi.fn(async () => ({ ok: true as const, snapshot })),
    onHandoffChanged: vi.fn(() => () => undefined),
    onHandoffProjectChanged: vi.fn(() => () => undefined),
    handoffQueueEdit: vi.fn(async () => ({ ok: true as const })),
    handoffQueueReorder: vi.fn(async () => ({ ok: true as const })),
    handoffProjectReorder: vi.fn(async () => ({ ok: true as const })),
    handoffProjectDirty: vi.fn(async () => ({ ok: true as const, files: ['src/App.tsx', 'notas.md'] })),
    handoffProjectAction: vi.fn(async () => ({ ok: true as const })),
    openInFolder: vi.fn(async () => ({ ok: true, message: '' }))
  } satisfies NextPromptsStripApi
}

describe('nextPrompts — as regras da faixa', () => {
  it('agrupa por plano, na ordem da fila do projeto, com o texto de cada prompt', () => {
    const plans = nextPlans(items, twoPlans)
    expect(plans.map((p) => p.header)).toEqual([
      'Plano Plano A — 2 prompts · ~1 h 20',
      'Plano Plano B — 1 prompt · ~1 h 30 · esperando o plano "Plano A" terminar'
    ])
    expect(plans[0].prompts.map((p) => p.text)).toEqual(['#1 · Prompt 2 de 3 — etapas: [x] Fazer X · ~40 min', '#2 · Prompt 3 de 3 · ~40 min'])
    expect(plans[0].prompts[0]).toMatchObject({ state: 'parada: o prompt anterior não foi concluído', stopped: true, actions: ['enviar', 'editar', 'tirar'] })
    expect(plans[0].prompts[1]).toMatchObject({ state: 'esperando a vez', actions: ['editar', 'tirar'] })
    // O B espera o A, que está parado: "Passar a vez" age no A.
    expect(plans[1]).toMatchObject({ actions: ['passar'], holderConversationId: 'conv-a', holderTitulo: 'Plano A' })
    // "Esta conversa": só o plano dela.
    expect(nextPlans(items, twoPlans, { conversationId: 'conv-b' }).map((p) => p.planTitulo)).toEqual(['Plano B'])
  })

  it('os estados: segurada pelo PO, rotina, pasta suja e a avaliação do PO', () => {
    expect(nextPlans([item({ estado: 'segurada', motivo: 'a etapa 2 já criou o endpoint' })], null)[0].prompts[0].state).toBe(
      'segurada pelo PO: a etapa 2 já criou o endpoint'
    )
    expect(nextPlans([item({ estado: 'rotina', motivo: 'commit + push autorizado' })], null)[0].prompts[0]).toMatchObject({
      state: 'commit + push autorizado',
      actions: ['cancelar']
    })
    const dirty = snap([plan({ estado: 'na_fila', comecou: false, sujo: 3 })])
    expect(nextPlans([item({ ordem: 1 })], dirty)[0]).toMatchObject({ header: expect.stringContaining('3 arquivos sem commit nesta pasta'), actions: ['comecar'] })
    const started = snap([plan({ loteId: 'lb', posicao: 1, comecarMesmoAssim: 'po', arquivosDoAnterior: ['a.ts', 'b.ts'] })], {
      avaliacao: { id: 'v', kind: 'vez', at: 'x', decisao: 'COMECAR', motivo: 'o B não toca no A', falhou: false, alterados: [], registro: 'C:\\aval', loteA: 'la', loteB: 'lb' }
    })
    expect(nextPlans([item({ loteId: 'lb' })], started)[0]).toMatchObject({
      note: 'o PO começou este plano: o B não toca no A — com 2 arquivos do plano anterior sem commit',
      registro: 'C:\\aval'
    })
  })

  it('moveBefore, fmtMinutes, promptText e o aviso do chat', () => {
    expect(moveBefore(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveBefore(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
    expect([fmtMinutes(40), fmtMinutes(120), fmtMinutes(95), fmtMinutes(null)]).toEqual(['~40 min', '~2 h', '~1 h 35', null])
    expect(promptText(item({ etapas: [], estimativaTotal: null }), 4)).toBe('#4 · Prompt 2 de 3')
    // O "Pedido do PO": as entregas são cartões (`card:<id>`) — só os títulos, sem o id interno.
    const pedido = item({ ordem: 1, totalPrompts: 1, estimativaTotal: null, etapas: [{ id: 'card:6c1b0e3a', titulo: 'Mensagem de erro de senha' }, { id: 'card:91f2', titulo: 'Revisar o texto da tela' }] })
    expect(promptText(pedido, 1)).toBe('#1 · Prompt 1 de 1 — tarefas: Mensagem de erro de senha, Revisar o texto da tela')
    expect(chatQueueNotice(items, 'conv-a')).toEqual({
      count: 2,
      text: '2 prompts esperando no quadro — o próximo parou: o prompt anterior não foi concluído',
      stopped: true
    })
    expect(chatQueueNotice(items, 'conv-b')).toEqual({ count: 1, text: '1 prompt esperando no quadro', stopped: false })
    expect(chatQueueNotice(items, 'outra')).toBeNull()
  })
})

function renderStrip(api = fakeApi(), over: Partial<Parameters<typeof NextPromptsStrip>[0]> = {}) {
  const onSendAnyway = vi.fn()
  render(
    <NextPromptsStrip
      projectCwd={CWD}
      conversationId="conv-a"
      wholeProject
      conversationTitles={{ 'conv-a': 'Implementação: Plano A', 'conv-b': 'Implementação: Plano B' }}
      onSendAnyway={onSendAnyway}
      api={api}
      {...over}
    />
  )
  return { api, onSendAnyway }
}

describe('NextPromptsStrip — a faixa no quadro', () => {
  it('mostra "Próximos prompts (N)", os planos e, em "Projeto inteiro", a conversa de cada um; sem nada, some', async () => {
    renderStrip()
    expect(await screen.findByText('Próximos prompts (3)')).toBeTruthy()
    expect(screen.getByText('Implementação: Plano B')).toBeTruthy()
    expect(screen.getByText('parada: o prompt anterior não foi concluído')).toBeTruthy()
    cleanup()
    const { container } = render(
      <NextPromptsStrip projectCwd={CWD} conversationId="x" wholeProject={false} conversationTitles={{}} api={fakeApi([])} />
    )
    await waitFor(() => expect(container.querySelector('.next-prompts')).toBeNull())
  })

  it('Enviar mesmo assim no da frente parado; Ver/editar grava o texto; Tirar da fila pede confirmação', async () => {
    const { api, onSendAnyway } = renderStrip()
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar mesmo assim' }))
    expect(onSendAnyway).toHaveBeenCalledWith('conv-a')

    fireEvent.click(screen.getAllByRole('button', { name: 'Ver/editar' })[1])
    const dialog = screen.getByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Texto do prompt'), { target: { value: 'Prompt 3 novo' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }))
    await waitFor(() => expect(api.handoffQueueEdit).toHaveBeenCalledWith({ envioId: 'a3', acao: 'editar', conteudo: 'Prompt 3 novo' }))

    fireEvent.click(screen.getAllByRole('button', { name: 'Tirar da fila' })[0])
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Tirar da fila' }))
    await waitFor(() => expect(api.handoffQueueEdit).toHaveBeenCalledWith({ envioId: 'a2', acao: 'tirar' }))
  })

  it('arrastar reordena os prompts DENTRO do plano e os planos inteiros — nunca um prompt entre os de outro', async () => {
    const { api } = renderStrip()
    const [a2, a3, b1] = await screen.findAllByRole('listitem')
    fireEvent.dragStart(a3)
    fireEvent.drop(a2)
    await waitFor(() => expect(api.handoffQueueReorder).toHaveBeenCalledWith({ conversationId: 'conv-a', envioIds: ['a3', 'a2'] }))
    // Um prompt do A solto no plano B: nada.
    fireEvent.dragStart(a2)
    fireEvent.drop(b1)
    expect(api.handoffQueueReorder).toHaveBeenCalledTimes(1)
    // O plano B arrastado para antes do A.
    const heads = document.querySelectorAll('.next-plan-head')
    fireEvent.dragStart(heads[1])
    fireEvent.drop(document.querySelectorAll('.next-plan')[0])
    await waitFor(() => expect(api.handoffProjectReorder).toHaveBeenCalledWith({ projectCwd: CWD, loteIds: ['lb', 'la'] }))
  })

  it('Passar a vez mostra antes o que o plano parado deixou sem commit; Começar mesmo assim (pasta suja)', async () => {
    const { api } = renderStrip()
    fireEvent.click(await screen.findByRole('button', { name: 'Passar a vez' }))
    const dialog = await screen.findByRole('dialog')
    expect(api.handoffProjectDirty).toHaveBeenCalledWith({ conversationId: 'conv-a' })
    expect(within(dialog).getByText('src/App.tsx')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Passar a vez' }))
    await waitFor(() => expect(api.handoffProjectAction).toHaveBeenCalledWith({ conversationId: 'conv-a', acao: 'passar' }))

    cleanup()
    const dirty = fakeApi([item({ ordem: 1 })], snap([plan({ estado: 'na_fila', comecou: false, sujo: 2 })]))
    renderStrip(dirty)
    fireEvent.click(await screen.findByRole('button', { name: 'Começar mesmo assim' }))
    await waitFor(() => expect(dirty.handoffProjectAction).toHaveBeenCalledWith({ conversationId: 'conv-a', acao: 'comecar' }))
  })

  it('erro do main aparece na faixa', async () => {
    const api = fakeApi()
    api.handoffQueueEdit.mockResolvedValueOnce({ ok: false, message: 'Este prompt já saiu da fila.' } as never)
    renderStrip(api)
    fireEvent.click((await screen.findAllByRole('button', { name: 'Tirar da fila' }))[0])
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Tirar da fila' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Este prompt já saiu da fila.')
  })
})

describe('ChatQueueNotice — o aviso no chat da implantação', () => {
  it('"N prompts esperando no quadro — ver", com o motivo do primeiro parado; "ver" abre a faixa', async () => {
    const onOpen = vi.fn()
    render(<ChatQueueNotice projectCwd={CWD} conversationId="conv-a" onOpen={onOpen} api={fakeApi()} />)
    expect(await screen.findByText('2 prompts esperando no quadro — o próximo parou: o prompt anterior não foi concluído')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ver' }))
    expect(onOpen).toHaveBeenCalled()
    cleanup()
    const { container } = render(<ChatQueueNotice projectCwd={CWD} conversationId="sem-fila" onOpen={onOpen} api={fakeApi()} />)
    await waitFor(() => expect(container.querySelector('.chat-queue-notice')).toBeNull())
  })
})
