// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoardItem } from '../../shared/ipc'
import { lastAgentAnswer, PoChatService, type PoChatDeps } from './poChatService'
import { PoChatStore } from './poChatStore'

/**
 * O serviço do "Fala, PO" com o modelo simulado: a conversa fica guardada por
 * projeto (outra instância lê o mesmo histórico, como depois de reiniciar), o
 * pedido leva só as últimas trocas, a resposta vira fontes e opções, e o chat
 * só LÊ o quadro — não escreve cartão nem passa pelo PO observador.
 */

const NOW = Date.UTC(2026, 9, 7, 12, 0)
const MIN = 60_000
let dir = ''

function item(id: string, over: Partial<BoardItem> = {}): BoardItem {
  return {
    id, projectId: 'p1', projectCwd: 'C:/loja', conversationId: 'conv-a', origin: 'agent', sourceId: id, sourceTitle: `Tarefa ${id}`,
    sourceStatus: 'completed', activeForm: null, seq: 0, poTitle: null, poNote: null, poStatus: null, poReason: null, poAt: null,
    dismissedAt: null, revision: 1, createdAt: '2026-10-07T10:00:00.000Z', updatedAt: '2026-10-07T11:58:00.000Z', ...over
  }
}

function deps(over: Partial<PoChatDeps> = {}) {
  let n = 0
  const ask = vi.fn(async (_prompt: string, _conv: string | undefined) => 'A tarefa a está concluída [K1], segundo o agente [C1].\nNAO_CONFIRMADO: ninguém viu no código\nVERIFICAR: 3')
  const board = vi.fn(async () => ({ projectId: 'p1', items: [item('a')] }))
  const d: PoChatDeps = {
    store: new PoChatStore(dir),
    key: (cwd) => cwd.toLowerCase(),
    board,
    prints: async () => [{ boardItemId: 'a', thumbUrl: 'data:image/jpeg;base64,MINI' }],
    envios: async () => [],
    queue: async () => [],
    conversations: async () => [
      { id: 'conv-a', payload: { title: 'Implementação', messages: [{ kind: 'assistant-text', text: 'Terminei a tarefa a.', ts: NOW - 12 * MIN }, { kind: 'assistant-text', text: 'subagente', parentToolUseId: 't1' }] } }
    ],
    tasks: async () => [],
    ask,
    now: () => NOW,
    newId: () => `m${++n}`,
    ...over
  }
  return { d, ask, board }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-code-po-chat-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('lastAgentAnswer', () => {
  it('a última resposta do agente principal (sem subagente) e a hora do turno', () => {
    expect(lastAgentAnswer({ messages: [{ kind: 'assistant-text', text: 'oi', ts: 5 }, { kind: 'assistant-text', text: 'sub', parentToolUseId: 'x' }] })).toEqual({ text: 'oi', at: 5 })
    expect(lastAgentAnswer(null)).toEqual({ text: null, at: null })
  })
})

describe('PoChatService', () => {
  it('pergunta → resposta com fontes (conversa e horário, cartão com miniatura) e o botão de verificar; o histórico fica guardado', async () => {
    const { d, ask } = deps()
    const res = await new PoChatService(d).ask('C:/Loja', 'O que falta fazer?')
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const [user, po] = res.messages
    expect(user).toMatchObject({ role: 'usuario', text: 'O que falta fazer?' })
    expect(po).toMatchObject({ role: 'po', text: 'A tarefa a está concluída, segundo o agente.', unconfirmed: 'ninguém viu no código' })
    expect(po.sources).toEqual(
      expect.arrayContaining([
        { kind: 'conversa', conversationId: 'conv-a', title: 'Implementação', at: NOW - 12 * MIN },
        { kind: 'card', cardId: 'a', conversationId: 'conv-a', title: 'Tarefa a', thumbUrl: 'data:image/jpeg;base64,MINI' }
      ])
    )
    expect(po.options).toEqual([{ kind: 'verificar', minutes: 3, question: 'O que falta fazer?' }])
    // A conta da conversa mais recente do projeto.
    expect(ask.mock.calls[0][1]).toBe('conv-a')
    // Outra instância (o app reiniciado) lê a mesma conversa.
    expect((await new PoChatService(deps().d).history('C:/loja')).map((m) => m.text)).toEqual(['O que falta fazer?', 'A tarefa a está concluída, segundo o agente.'])
  })

  it('o pedido leva só as últimas ~10 trocas, não a conversa inteira', async () => {
    const { d, ask } = deps()
    const service = new PoChatService(d)
    for (let i = 0; i < 13; i++) await service.ask('C:/loja', `pergunta ${i}`)
    const prompt = ask.mock.calls.at(-1)![0]
    expect(prompt).not.toMatch(/USUÁRIO: pergunta 1\b/)
    expect(prompt).toMatch(/USUÁRIO: pergunta 2\b/)
    expect(prompt).toMatch(/=== PERGUNTA ===\npergunta 12$/)
  })

  it('o chat do PO só LÊ o quadro: nenhuma escrita, nenhum cartão novo', async () => {
    const writes = { applyPo: vi.fn(), createBoardPoItem: vi.fn(), observe: vi.fn() }
    const { d, board } = deps()
    await new PoChatService({ ...d, ...(writes as object) }).ask('C:/loja', 'Resumo de hoje')
    expect(board).toHaveBeenCalledWith('C:/loja')
    for (const fn of Object.values(writes)) expect(fn).not.toHaveBeenCalled()
  })

  it('quadro fora do ar ou modelo sem resposta: a bolha do PO diz o motivo', async () => {
    const off = deps({ board: async () => null })
    const a = await new PoChatService(off.d).ask('C:/loja', 'q')
    expect(a.ok && a.messages.at(-1)).toMatchObject({ role: 'po', error: expect.stringMatching(/quadro está indisponível/) })
    expect(off.ask).not.toHaveBeenCalled()
    const mute = deps({ ask: vi.fn(async () => '') })
    const b = await new PoChatService(mute.d).ask('C:/loja', 'q')
    expect(b.ok && b.messages.at(-1)).toMatchObject({ role: 'po', error: expect.stringMatching(/sem resposta do modelo/) })
  })

  it('pergunta vazia: recusa sem gravar', async () => {
    const { d } = deps()
    expect(await new PoChatService(d).ask('C:/loja', '   ')).toEqual({ ok: false, message: 'Escreva a pergunta.' })
    expect(await new PoChatService(d).history('C:/loja')).toEqual([])
  })
})
