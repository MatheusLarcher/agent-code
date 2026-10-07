// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoardItem } from '../../shared/ipc'
import type { PoChatMessage, PoChatOption } from '../../shared/poChat'
import { entrega, envio } from '../handoffTracking/handoffTestKit'
import { decideQueue } from '../handoffTracking/handoffQueue'
import { CARD_ETAPA_PREFIX, cardForEtapa, syncEntregas, turnEndOutcome } from '../handoffTracking/handoffRules'
import { parsePoChatReply, poRequestText, type PoChatContext } from './poChatModel'
import { PoChatService, type PoChatDeps } from './poChatService'
import { PoChatStore } from './poChatStore'

/**
 * "Mandar fazer": a prévia é montada pelo código (do modelo, só a nota curta),
 * nada sai sem o clique, o aprovado vira um plano "Pedido do PO" na fila do
 * projeto (uma vez só), e o envio conclui quando os cartões citados concluem.
 */

const NOW = Date.UTC(2026, 9, 7, 12, 0)
let dir = ''

const ctx: PoChatContext = {
  projectName: 'loja',
  boardAt: NOW,
  cards: [
    { id: 'k-api', conversationId: 'conv-b', title: 'API de login', status: 'a fazer', poReason: 'o turno terminou sem concluir esta tarefa', awaiting: 'Aguardando você', deadline: null, prints: 0, thumbUrl: null, updatedAt: '' },
    { id: 'k-doc', conversationId: 'conv-b', title: 'Documentar a API', status: 'a fazer', poReason: null, awaiting: null, deadline: null, prints: 0, thumbUrl: null, updatedAt: '' }
  ],
  conversations: [{ id: 'conv-b', title: 'Backend', lastAnswer: null, lastAt: null }],
  queue: [],
  tasks: []
}

function card(id: string, over: Partial<BoardItem> = {}): BoardItem {
  return {
    id, projectId: 'p1', projectCwd: 'C:/loja', conversationId: 'conv-b', origin: 'agent', sourceId: id, sourceTitle: `Tarefa ${id}`,
    sourceStatus: 'pending', activeForm: null, seq: 0, poTitle: null, poNote: null, poStatus: null, poReason: null, poAt: null,
    dismissedAt: null, revision: 1, createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T11:00:00.000Z', ...over
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-code-po-send-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('a prévia do "Mandar fazer"', () => {
  it('o texto é do código, a partir dos cartões; do modelo, só a nota curta (até 300)', () => {
    const reply = parsePoChatReply(`Falta a API [K1].\nMANDAR: K1, K2 | priorize a API; a doc pode ser curta ${'x'.repeat(400)}`, ctx, 'q')
    const o = reply.options.find((x): x is Extract<PoChatOption, { kind: 'mandar' }> => x.kind === 'mandar')!
    expect(o).toMatchObject({ conversationId: 'conv-b', conversationTitle: 'Backend', cardIds: ['k-api', 'k-doc'], titles: ['API de login', 'Documentar a API'] })
    expect(o.note!.length).toBe(300)
    expect(o.text).toBe(poRequestText(ctx.cards, o.note!))
    expect(o.text).toMatch(/^Pedido do PO, aprovado pelo usuário no "Fala, PO"/)
    expect(o.text).toMatch(/- "API de login" \(a fazer\) — motivo do PO: o turno terminou sem concluir esta tarefa — Aguardando você/)
    expect(o.text).not.toMatch(/Falta a API/)
  })
})

describe('PoChatService.send', () => {
  async function setup(over: Partial<PoChatDeps> = {}) {
    const store = new PoChatStore(dir)
    const proposal = parsePoChatReply('Falta a API [K1].\nMANDAR: K1 | priorize a API', ctx, 'O que falta fazer?')
    const message: PoChatMessage = { id: 'po-1', role: 'po', text: proposal.text, at: NOW, options: proposal.options }
    await store.append('c:/loja', message)
    const registerRequest = vi.fn(async () => undefined)
    let n = 0
    const d: PoChatDeps = {
      store,
      key: (cwd) => cwd.toLowerCase(),
      board: async () => null,
      prints: async () => [],
      envios: async () => [],
      queue: async () => [],
      conversations: async () => [],
      tasks: async () => [],
      ask: vi.fn(async () => ''),
      registerRequest,
      now: () => NOW,
      newId: () => `m${++n}`,
      ...over
    }
    return { service: new PoChatService(d), registerRequest, d }
  }

  it('nada sai sem o clique: perguntar e propor não registram nada', async () => {
    const { registerRequest } = await setup()
    expect(registerRequest).not.toHaveBeenCalled()
  })

  it('aprovado: vira "Pedido do PO" na fila, com o texto da prévia e os cartões ligados; mandado uma vez só', async () => {
    const { service, registerRequest } = await setup()
    const res = await service.send('C:/loja', 'po-1', 0)
    expect(registerRequest).toHaveBeenCalledWith({
      cwd: 'C:/loja',
      conversationId: 'conv-b',
      conversationTitle: 'Backend',
      planTitulo: 'Pedido do PO: API de login',
      text: poRequestText([ctx.cards[0]], 'priorize a API'),
      cards: [{ id: 'k-api', title: 'API de login' }]
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.messages[0].options![0]).toMatchObject({ kind: 'mandar', sent: { conversationId: 'conv-b', conversationTitle: 'Backend', at: NOW } })
    expect(res.messages.at(-1)).toMatchObject({
      role: 'po',
      text: expect.stringMatching(/^Mandei para 'Backend': entrou na fila do projeto como "Pedido do PO: API de login"/),
      options: [{ kind: 'ver-fila' }, { kind: 'abrir-conversa', conversationId: 'conv-b', title: 'Backend' }]
    })
    expect(await service.send('C:/loja', 'po-1', 0)).toEqual({ ok: false, message: 'esse pedido já foi mandado' })
    expect(registerRequest).toHaveBeenCalledTimes(1)
  })

  it('conversa dona fora deste PC: vai para a conversa nova (sem cartões ligados — eles são da outra)', async () => {
    const { service, registerRequest } = await setup()
    await service.send('C:/loja', 'po-1', 0, { conversationId: 'conv-nova', conversationTitle: 'Pedido do PO: API de login' })
    expect(registerRequest).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-nova', cards: [] }))
  })
})

describe('o envio "Pedido do PO" na fila e no acompanhamento', () => {
  const pedido = envio({
    id: 'pedido',
    arquivo: 'pedido-po',
    status: 'na_fila',
    enviadoEm: null,
    iniciadoEm: null,
    concluidoEm: null,
    conversationId: 'conv-b',
    loteId: 'pedido-po-1',
    entregas: [entrega({ id: 'e1', envioId: 'pedido', etapaId: `${CARD_ETAPA_PREFIX}k-api`, etapaTitulo: 'API de login', estimativaPlano: null })]
  })

  it('com a conversa livre, sai na hora — mesmo como o 1º prompt dela; com turno rodando, espera', () => {
    expect(decideQueue([pedido])).toMatchObject({ kind: 'next', envio: { id: 'pedido' } })
    const stopped = envio({ id: 'antes', status: 'incompleta', loteId: 'plano-a', ordem: 1 })
    expect(decideQueue([stopped, pedido])).toMatchObject({ kind: 'next', envio: { id: 'pedido' } })
    const running = envio({ id: 'antes', status: 'em_execucao', loteId: 'plano-a', ordem: 1 })
    expect(decideQueue([running, pedido])).toMatchObject({ kind: 'hold', envio: { id: 'pedido' } })
  })

  it('a entrega "card:<id>" segue o cartão citado; o envio só conclui com ele concluído', () => {
    const done = card('k-api', { sourceStatus: 'completed' })
    expect(cardForEtapa([card('outro'), done], `${CARD_ETAPA_PREFIX}k-api`)?.id).toBe('k-api')
    const synced = syncEntregas({ ...pedido, status: 'em_execucao' }, [done], { now: '2026-10-07T12:00:00.000Z', poEnabled: true })
    expect(synced[0].patch).toMatchObject({ status: 'concluida', boardItemId: 'k-api' })
    const running = { ...pedido, status: 'em_execucao' as const }
    expect(turnEndOutcome({ ...running, entregas: [{ ...running.entregas[0], status: 'concluida' }] }, [done], { now: 'x', turnError: null }).envio.status).toBe('concluida')
    expect(turnEndOutcome(running, [card('k-api')], { now: 'x', turnError: null }).envio.status).toBe('incompleta')
  })
})
