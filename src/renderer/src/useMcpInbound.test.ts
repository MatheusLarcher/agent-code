import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCP_TASK_MODEL } from '@shared/mcpInbound'
import type { Conversation } from './types'
import { handleMcpInbound, mcpConversationFields, reportMcpDropped, type McpInboundDeps, type McpQueueItem } from './useMcpInbound'
import { loadConversationsByIds } from './storage'

vi.mock('./storage', () => ({ loadConversationsByIds: vi.fn(async () => []) }))

const conv = (id: string, extra: Partial<Conversation> = {}): Conversation =>
  ({ id, title: 't', cwd: 'C:\\p', model: 'm', sdkSessionId: null, messages: [], tokens: { context: 0, output: 0, cost: 0 }, createdAt: 1, updatedAt: 1, ...extra }) as Conversation

function setup(opts: { busy?: boolean; queueOnDispatch?: boolean } = {}) {
  const mcpTaskFailed = vi.fn(async () => undefined)
  ;(window as unknown as { api: unknown }).api = { mcpTaskFailed }
  let queue: McpQueueItem[] = []
  const d: McpInboundDeps<McpQueueItem> = {
    hydrated: true,
    convsRef: { current: [conv('c-velha')] },
    queueRef: { current: [] },
    setQueue: (fn) => {
      queue = typeof fn === 'function' ? fn(queue) : fn
    },
    createBackground: vi.fn((cwd, id, extra) => conv(id, { cwd, ...extra })),
    addLoaded: vi.fn(),
    // Como o dispatch do App: o item da fila nasce com o id da tarefa que recebeu.
    dispatch: vi.fn(async (c: Conversation, full: string, _t: string, _i: unknown, _th: unknown, taskId: string) => {
      if (opts.queueOnDispatch) d.queueRef.current = [...d.queueRef.current, { id: 'q1', convId: c.id, full, mcpTaskId: taskId }]
    }),
    isBusy: () => opts.busy === true
  }
  return { d, mcpTaskFailed, queue: () => queue }
}

afterEach(() => vi.clearAllMocks())

describe('handleMcpInbound', () => {
  it('conversa nova: cria ao fundo com título travado e o modelo MCP, e despacha', async () => {
    const { d, mcpTaskFailed } = setup({ busy: true })
    await handleMcpInbound(d, { taskId: 't1', convId: 'c-nova', text: 'faça', create: { cwd: 'C:\\f', title: 'Forgia — faça' } })
    expect(d.createBackground).toHaveBeenCalledWith('C:\\f', 'c-nova', mcpConversationFields('Forgia — faça'))
    expect(mcpConversationFields('x')).toMatchObject({ titleSource: 'user', model: MCP_TASK_MODEL })
    expect(d.convsRef.current.map((c) => c.id)).toContain('c-nova')
    expect(d.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-nova' }), 'faça', 'faça', [], [], 't1')
    expect(mcpTaskFailed).not.toHaveBeenCalled()
  })

  it('imagens do MCP entram pelo dispatch como imagem colada (miniatura data:) e a conversa nova mostra o modelo pedido', async () => {
    const { d } = setup({ busy: true })
    const images = [{ mediaType: 'image/png', data: 'QUJD', label: 'midia:1 = frente.png' }]
    await handleMcpInbound(d, {
      taskId: 't5',
      convId: 'c-img',
      text: 'compare {{midia:1}} com a peça',
      model: 'gpt-6-sol',
      images,
      create: { cwd: 'C:\\f', title: 'Forgia — compare' }
    })
    expect(d.createBackground).toHaveBeenCalledWith('C:\\f', 'c-img', mcpConversationFields('Forgia — compare', 'gpt-6-sol'))
    expect(mcpConversationFields('x', 'gpt-6-sol').model).toBe('gpt-6-sol')
    expect(d.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c-img' }),
      'compare {{midia:1}} com a peça',
      'compare {{midia:1}} com a peça',
      images,
      ['data:image/png;base64,QUJD'],
      't5'
    )
  })

  it('conversa ocupada: o item da fila leva o id da tarefa (vindo do dispatch, não casado pelo texto)', async () => {
    const { d, mcpTaskFailed } = setup({ queueOnDispatch: true })
    // Uma mensagem do usuário com o MESMO texto já na fila continua sem id.
    d.queueRef.current = [{ id: 'u1', convId: 'c-velha', full: 'segundo' }]
    await handleMcpInbound(d, { taskId: 't2', convId: 'c-velha', text: 'segundo' })
    expect(d.queueRef.current).toEqual([
      { id: 'u1', convId: 'c-velha', full: 'segundo' },
      { id: 'q1', convId: 'c-velha', full: 'segundo', mcpTaskId: 't2' }
    ])
    expect(mcpTaskFailed).not.toHaveBeenCalled()
  })

  it('nem na fila nem rodando (envio falhou) → avisa o main; conversa sumida também', async () => {
    const { d, mcpTaskFailed } = setup({ busy: false })
    await handleMcpInbound(d, { taskId: 't3', convId: 'c-velha', text: 'x' })
    expect(mcpTaskFailed).toHaveBeenCalledWith('t3', expect.stringMatching(/Não consegui enviar/))
    await handleMcpInbound(d, { taskId: 't4', convId: 'c-sumiu', text: 'x' })
    expect(mcpTaskFailed).toHaveBeenCalledWith('t4', 'A conversa não foi encontrada no Agent Code.')
  })

  it('tarefa para a Central falha com aviso claro: nem cria, nem lê do banco, nem despacha', async () => {
    const { d, mcpTaskFailed } = setup({ busy: true })
    d.convsRef.current = [...d.convsRef.current, conv('central', { cwd: '', mode: 'central' })]
    await handleMcpInbound(d, { taskId: 't6', convId: 'central', text: 'faça' })
    // Mesmo pedindo para criar, o id fixo da Central nunca vira conversa de tarefa.
    await handleMcpInbound(d, { taskId: 't7', convId: 'central', text: 'faça', create: { cwd: 'C:\\f', title: 'x' } })
    expect(mcpTaskFailed).toHaveBeenCalledWith('t6', 'A Central não recebe tarefas diretamente.')
    expect(mcpTaskFailed).toHaveBeenCalledWith('t7', 'A Central não recebe tarefas diretamente.')
    expect(d.createBackground).not.toHaveBeenCalled()
    expect(loadConversationsByIds).not.toHaveBeenCalled()
    expect(d.dispatch).not.toHaveBeenCalled()
  })

  it('reportMcpDropped avisa só os itens de tarefa MCP, como cancelados', () => {
    const { mcpTaskFailed } = setup()
    reportMcpDropped([{ id: 'a', convId: 'c', full: 'x' }, { id: 'b', convId: 'c', full: 'y', mcpTaskId: 't9' }], 'Stop')
    expect(mcpTaskFailed).toHaveBeenCalledTimes(1)
    expect(mcpTaskFailed).toHaveBeenCalledWith('t9', 'Stop', true)
  })
})
