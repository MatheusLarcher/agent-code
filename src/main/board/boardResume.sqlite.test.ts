// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boardItemAwaitingBadge, type BoardConfig, type BoardItem, type ChatEvent } from '../../shared/ipc'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { Po } from '../po/po'
import type { PoLogEntry } from '../po/poLog'
import { BoardService } from './boardService'

/**
 * Replays dos dois casos do plano contra o repositório SQLite DE VERDADE (SQL,
 * `po_at`, limpeza da camada `po_*` na ingestão), ligando quadro e PO na mesma
 * ordem do tee do index.ts. O modelo do PO é roteirizado.
 */

const CWD = process.cwd()
const CONV = 'conv-replay'
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function world(opts: { poEnabled?: boolean; ask?: (prompt: string) => Promise<string> } = {}) {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-resume-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  const log: PoLogEntry[] = []
  const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: opts.poEnabled ?? true, model: 'claude-sonnet-5-5' } })
  // `po` é criado logo abaixo; a referência preguiçosa é a mesma do index.ts.
  const board = new BoardService({
    repository: () => repository,
    poSettled: (id): Promise<void> => po.settled(id),
    poWaitMs: 2_000
  })
  // Cada mensagem chega 61 s depois da anterior: fora do cooldown do PO, como
  // numa conversa real em que o usuário lê a resposta antes de responder.
  let clock = 1_000_000
  const po: Po = new Po({
    config,
    board,
    now: () => clock,
    ask: opts.ask ?? (async () => 'OK'),
    gateActive: async () => false,
    scheduleFlush: () => () => undefined,
    decisionLog: (entry) => log.push(entry)
  })
  const emit = (event: ChatEvent): void => {
    board.observe(CONV, CWD, event)
    po.observe(CONV, event)
  }
  const userSays = (text: string): Promise<void> => {
    clock += 61_000
    po.noteUserMessage(CONV, CWD, text)
    return board.resumeTurn(CONV, CWD)
  }
  const idle = async (): Promise<void> => {
    await board.settled(CONV)
    await po.settled(CONV)
    await board.turnClosed(CONV)
    await po.settled(CONV)
  }
  const cards = async (): Promise<BoardItem[]> => (await board.list(CWD, { conversationId: CONV })) ?? []
  return { emit, userSays, idle, cards, log }
}

const taskList = (status: 'pending' | 'in_progress' | 'completed', title = 'Investigar e corrigir perda de configurações'): ChatEvent => ({
  kind: 'task-list',
  items: [{ id: '1', content: title, status, activeForm: 'Investigando' }]
})
const reply = (text: string): ChatEvent => ({ kind: 'assistant-text', id: 'a', text, final: true })
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

describe('replay no SQLite real — quadro + PO', () => {
  for (const poEnabled of [true, false]) {
    it(`caso 1 (PO ${poEnabled ? 'ligado' : 'desligado'}): "pode fazer" promove na hora; selo aparece e some`, async () => {
      const w = await world({ poEnabled })
      await w.userSays('investiga a perda de configurações')
      w.emit(taskList('in_progress'))
      w.emit(reply('Diagnóstico: a carga pula quando o banco está fora. Posso corrigir?'))
      w.emit(result)
      await w.idle()

      let [card] = await w.cards()
      expect(card.poStatus).toBe('pending')
      expect(boardItemAwaitingBadge(card)?.label).toBe('Aguardando você')

      await w.userSays('pode fazer')
      ;[card] = await w.cards()
      expect(card).toMatchObject({ poStatus: 'in_progress', poReason: 'o usuário retomou a conversa' })
      expect(boardItemAwaitingBadge(card)).toBeNull()
    })
  }

  it('caso 1 com o modelo do PO fora do ar: a promoção acontece igual e o diário registra a falha', async () => {
    const w = await world({
      ask: async () => {
        throw new Error('modelo indisponível')
      }
    })
    await w.userSays('investiga')
    w.emit(taskList('in_progress'))
    w.emit(result)
    await w.idle()
    await w.userSays('pode fazer')
    const [card] = await w.cards()
    expect(card.poStatus).toBe('in_progress')
    expect(w.log.some((entry) => entry.outcome === 'falha')).toBe(true)
  })

  it('caso 1 completo: o agente conclui, responde com o resultado e o fechamento conclui o cartão', async () => {
    let turn = 0
    const w = await world({
      ask: async (prompt) => {
        if (!prompt.includes('AÇÕES DESTE TURNO')) return 'OK'
        turn++
        // O fechamento só conclui quando a resposta entrega o resultado (turno 2).
        return turn === 2 && prompt.includes('Corrigido: a config agora recarrega')
          ? `CONCLUIR ${(await w.cards())[0].id} | a resposta final entregou a correção`
          : 'OK'
      }
    })
    await w.userSays('investiga')
    w.emit(taskList('in_progress'))
    w.emit(reply('Diagnóstico pronto. Posso corrigir?'))
    w.emit(result)
    await w.idle()
    expect((await w.cards())[0].poStatus).toBe('pending')

    await w.userSays('pode fazer')
    w.emit({ kind: 'tool-use', id: 't', name: 'Edit', input: { file_path: 'src/main/config.ts' }, parentToolUseId: null })
    w.emit(reply('Corrigido: a config agora recarrega quando o banco volta. Testes verdes.'))
    w.emit(result)
    await w.idle()

    const [card] = await w.cards()
    expect(card).toMatchObject({ poStatus: 'completed', poReason: 'a resposta final entregou a correção' })
    expect(boardItemAwaitingBadge(card)).toBeNull()
  })

  it('caso 2: resposta terminando com pergunta não conclui; próxima mensagem promove em vez de duplicar', async () => {
    const w = await world({
      // A abertura cria o cartão da pesquisa; o fechamento não conclui porque a
      // resposta termina pedindo decisão ao usuário.
      ask: async (prompt) =>
        prompt.includes('AÇÕES DESTE TURNO') ? 'OK' : prompt.includes('QUADRO ATUAL:\n(vazio)') ? 'NOVA | Pesquisar opções de cadastro no sistema | pedido do usuário' : 'OK'
    })
    await w.userSays('pesquisa direito')
    await w.idle()
    w.emit(reply('Achei três caminhos de cadastro. Qual você prefere que eu detalhe?'))
    w.emit(result)
    await w.idle()

    let list = await w.cards()
    expect(list).toHaveLength(1)
    expect(boardItemAwaitingBadge(list[0])?.label).toBe('Aguardando você')

    await w.userSays('o segundo')
    list = await w.cards()
    expect(list).toHaveLength(1)
    expect(list[0].poStatus).toBe('in_progress')
  })

  it('assunto novo: o PO cria a NOVA e o cartão antigo volta a "a fazer" no fim do turno (vai-e-vem)', async () => {
    const w = await world({
      ask: async (prompt) =>
        !prompt.includes('AÇÕES DESTE TURNO') && prompt.includes('exportação')
          ? 'NOVA | Corrigir a exportação de XML | pedido novo do usuário'
          : 'OK'
    })
    await w.userSays('faz A')
    w.emit(taskList('in_progress', 'Tarefa A'))
    w.emit(result)
    await w.idle()

    await w.userSays('agora corrige a exportação')
    await w.idle()
    let list = await w.cards()
    expect(list.find((c) => c.sourceTitle === 'Tarefa A')?.poStatus).toBe('in_progress')
    expect(list.find((c) => c.sourceTitle === 'Corrigir a exportação de XML')).toBeTruthy()

    w.emit(result)
    await w.idle()
    list = await w.cards()
    const a = list.find((c) => c.sourceTitle === 'Tarefa A')
    expect(a?.poStatus).toBe('pending')
    expect(boardItemAwaitingBadge(a as BoardItem)?.label).toBe('Aguardando você')
  })
})
