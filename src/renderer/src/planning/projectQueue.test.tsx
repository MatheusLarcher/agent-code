import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { HandoffProjectFolder, HandoffProjectPlan, HandoffProjectSnapshot } from '@shared/handoffProject'
import { projectHoldsChat, projectNotice } from './projectQueue'
import { ProjectQueueNotice } from './ProjectQueueNotice'
import { useProjectQueue } from './useProjectQueue'

/**
 * A fila do projeto vista da conversa: a mensagem do usuário no A fica
 * guardada com o B na vez; os avisos ("na fila do projeto (2º)", a pasta suja,
 * a resposta guardada, a decisão do PO, a conversa avulsa) e os botões fixos; e
 * a fila do chat sai quando a conversa é solta.
 */

afterEach(cleanup)

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

const folder = (plans: HandoffProjectPlan[], over: Partial<HandoffProjectFolder> = {}): HandoffProjectFolder => ({
  key: 'c:/proj',
  cwd: 'C:\\proj',
  plans,
  implantacaoEmCurso: plans[0]?.comecou ?? false,
  avaliacao: null,
  avaliando: null,
  resposta: null,
  ...over
})

const snap = (...folders: HandoffProjectFolder[]): HandoffProjectSnapshot => ({ caseInsensitive: true, folders })

const A = (over: Partial<HandoffProjectPlan> = {}) => plan(over)
const B = (over: Partial<HandoffProjectPlan> = {}) => plan({ loteId: 'lb', conversationId: 'conv-b', planTitulo: 'Plano B', ...over })

describe('projectHoldsChat — a resposta no A fica guardada com o B na vez', () => {
  it('guarda no plano que começou e está atrás de outro, ou com outro rodando', () => {
    const s = snap(folder([B({ posicao: 1, estado: 'rodando' }), A({ posicao: 2, estado: 'parado' })]))
    expect(projectHoldsChat(s, 'conv-a')).toBe(true)
    expect(projectHoldsChat(s, 'conv-b')).toBe(false)
    // O A recuperou a vez, mas o B ainda roda o prompt atual.
    expect(projectHoldsChat(snap(folder([A({ estado: 'parado' }), B({ posicao: 2, estado: 'rodando' })])), 'conv-a')).toBe(true)
  })

  it('não guarda: plano que nem começou, conversa fora da fila, "Enviar agora mesmo assim"', () => {
    const s = snap(folder([A({ estado: 'rodando' }), B({ posicao: 2, estado: 'na_fila', comecou: false })]))
    expect(projectHoldsChat(s, 'conv-b')).toBe(false)
    expect(projectHoldsChat(s, 'outra')).toBe(false)
    const now = snap(
      folder([A({ estado: 'parado' }), B({ posicao: 2 })], {
        resposta: { conversationId: 'conv-a', at: 'x', estado: 'agora', motivo: null, pergunta: null, por: 'usuario' }
      })
    )
    expect(projectHoldsChat(now, 'conv-a')).toBe(false)
  })
})

describe('projectNotice — o aviso da conversa', () => {
  it('o plano na fila: "na fila do projeto (2º)", e "Começar mesmo assim" com o da vez parado', () => {
    const running = snap(folder([A({ estado: 'rodando' }), B({ posicao: 2, estado: 'na_fila', comecou: false })]))
    expect(projectNotice(running, { id: 'conv-b', cwd: 'C:\\proj' })).toMatchObject({
      text: 'Na fila do projeto (2º): esperando o plano "Plano A" terminar.',
      actions: []
    })
    const stopped = snap(folder([A({ estado: 'parado' }), B({ posicao: 2, estado: 'na_fila', comecou: false })], { avaliando: 'vez' }))
    expect(projectNotice(stopped, { id: 'conv-b', cwd: 'C:\\proj' })).toMatchObject({
      detail: 'O PO está avaliando se este plano pode começar.',
      actions: [{ acao: 'comecar', label: 'Começar mesmo assim' }]
    })
  })

  it('a pasta suja segura o começo: "N arquivos sem commit" + "Começar mesmo assim"', () => {
    const s = snap(folder([B({ estado: 'na_fila', comecou: false, sujo: 3 })]))
    expect(projectNotice(s, { id: 'conv-b', cwd: 'C:\\proj' })).toMatchObject({
      tone: 'warn',
      text: 'Segurado: 3 arquivos sem commit nesta pasta.',
      actions: [{ acao: 'comecar' }]
    })
  })

  it('a resposta guardada: o PO decidindo, a pergunta com os dois botões fixos e a decisão', () => {
    const base = [B({ posicao: 1, estado: 'rodando', restanteMin: 40 }), A({ posicao: 2, estado: 'parado' })]
    const reply = (over: Partial<NonNullable<HandoffProjectFolder['resposta']>>) =>
      snap(folder(base, { resposta: { conversationId: 'conv-a', at: 'x', estado: 'decidindo', motivo: null, pergunta: null, por: null, ...over } }))
    const conv = { id: 'conv-a', cwd: 'C:\\proj' }
    expect(projectNotice(reply({}), conv)).toMatchObject({
      text: 'Sua resposta está guardada: o plano "Plano B" está rodando nesta pasta. O PO está decidindo…',
      actions: [{ acao: 'enviar_agora', label: 'Enviar agora mesmo assim' }]
    })
    expect(projectNotice(reply({ estado: 'pergunta', pergunta: 'volto ao A já?' }), conv)?.actions.map((a) => a.label)).toEqual([
      'O A no fim do prompt do B',
      'Esperar o B terminar',
      'Enviar agora mesmo assim'
    ])
    expect(projectNotice(reply({ estado: 'esperar_b', motivo: 'o B acaba logo', por: 'po' }), conv)?.text).toBe(
      'O PO decidiu: esperar o plano "Plano B" terminar (~40 min) — o B acaba logo'
    )
    expect(projectNotice(reply({ estado: 'retomar_a', motivo: 'escolha sua', por: 'usuario' }), conv)?.text).toBe(
      'Você escolheu: este plano volta no fim do prompt atual do plano "Plano B".'
    )
  })

  it('o PO começou o B com a pasta suja; "o PO alterou"; "ver avaliação"', () => {
    const s = snap(
      folder([B({ estado: 'rodando', comecarMesmoAssim: 'po', arquivosDoAnterior: ['a.ts', 'b.ts'] }), A({ posicao: 2, estado: 'parado' })], {
        avaliacao: {
          id: 'e1',
          kind: 'vez',
          at: 'x',
          decisao: 'COMECAR',
          motivo: 'o B não toca no que o A deixou',
          falhou: false,
          alterados: ['notas.md'],
          registro: 'C:\\dados\\po-avaliacoes\\1',
          loteA: 'la',
          loteB: 'lb'
        }
      })
    )
    expect(projectNotice(s, { id: 'conv-b', cwd: 'C:\\proj' })).toEqual({
      tone: 'info',
      text: 'O PO começou este plano: o B não toca no que o A deixou',
      detail: 'O PO começou com 2 arquivos do plano anterior sem commit (a lista foi no 1º prompt, para não mexer neles). O PO alterou: notas.md.',
      actions: [],
      registro: 'C:\\dados\\po-avaliacoes\\1'
    })
  })

  it('o plano parado com outro esperando: "Passar a vez"; a conversa avulsa da pasta: o aviso', () => {
    const s = snap(folder([A({ estado: 'parado' }), B({ posicao: 2, estado: 'na_fila', comecou: false })]))
    expect(projectNotice(s, { id: 'conv-a', cwd: 'C:\\proj' })?.actions).toEqual([{ acao: 'passar', label: 'Passar a vez' }])
    expect(projectNotice(s, { id: 'avulsa', cwd: 'c:/PROJ/' })).toMatchObject({
      tone: 'warn',
      text: 'Uma implantação está rodando neste projeto — mexer nos mesmos arquivos mistura as mudanças.'
    })
    expect(projectNotice(s, { id: 'avulsa', cwd: 'C:\\outro' })).toBeNull()
  })
})

describe('ProjectQueueNotice — os botões', () => {
  it('cada botão manda a ação; "ver avaliação" abre o registro', () => {
    const onAction = vi.fn()
    const onOpenRecord = vi.fn()
    render(
      <ProjectQueueNotice
        notice={{ tone: 'info', text: 'Na fila', actions: [{ acao: 'comecar', label: 'Começar mesmo assim' }], registro: 'C:\\r' }}
        onAction={onAction}
        onOpenRecord={onOpenRecord}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Começar mesmo assim' }))
    expect(onAction).toHaveBeenCalledWith('comecar')
    fireEvent.click(screen.getByRole('button', { name: 'ver avaliação' }))
    expect(onOpenRecord).toHaveBeenCalledWith('C:\\r')
  })
})

describe('useProjectQueue — a foto e a soltura', () => {
  it('lê a foto na abertura e solta a fila do chat da conversa que deixou de estar guardada', async () => {
    let push: ((s: HandoffProjectSnapshot) => void) | null = null
    const held = snap(folder([B({ estado: 'rodando' }), A({ posicao: 2, estado: 'parado' })]))
    const api = {
      handoffProjectStatus: vi.fn(async () => ({ ok: true as const, snapshot: held })),
      onHandoffProjectChanged: vi.fn((cb: (s: HandoffProjectSnapshot) => void) => {
        push = cb
        return () => undefined
      })
    }
    const onRelease = vi.fn()
    const { result } = renderHook(() => useProjectQueue(true, { api, onRelease }))
    await waitFor(() => expect(result.current.held('conv-a')).toBe(true))

    // O gate acabou de dar a vez: uma licença, uma vez só.
    result.current.allowOnce('conv-a')
    expect(result.current.held('conv-a')).toBe(false)
    expect(result.current.held('conv-a')).toBe(true)

    act(() => push!(snap(folder([A({ estado: 'parado' }), B({ posicao: 2, estado: 'entre_prompts' })]))))
    await waitFor(() => expect(onRelease).toHaveBeenCalledWith('conv-a'))
    expect(result.current.held('conv-a')).toBe(false)
  })
})
