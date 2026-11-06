// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOARD_TURN_END_REASON, boardItemStatus, type BoardConfig, type BoardItem, type ChatEvent } from '../../shared/ipc'
import { BoardService } from '../board/boardService'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { Po } from './po'
import { PO_FOREIGN_MARK } from './poPromptText'

/**
 * O pedido feito pelo CHAT sobre um cartão que nasceu em OUTRA conversa do
 * projeto (poForeign.ts), no SQLite de verdade e com o quadro e o PO ligados na
 * ordem do index.ts. O modelo do PO é roteirizado por `ask`.
 */

const CWD = process.cwd()
const A = 'conv-dona'
const B = 'conv-chat'
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const reply = (text: string): ChatEvent => ({ kind: 'assistant-text', id: 'a', text, final: true })
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

async function world(ask: (prompt: string, card: () => Promise<BoardItem>) => Promise<string>) {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-foreign-'))
  dirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })
  const board = new BoardService({ repository: () => repository, poSettled: (id): Promise<void> => po.settled(id), poWaitMs: 2_000 })
  let clock = 1_000_000
  const card = async (): Promise<BoardItem> =>
    ((await board.list(CWD)) ?? []).find((item) => item.sourceTitle === 'Corrigir o erro do login') as BoardItem
  const prompts: string[] = []
  const po: Po = new Po({
    config,
    board,
    now: () => clock,
    ask: async (prompt) => {
      prompts.push(prompt)
      return ask(prompt, card)
    },
    gateActive: async () => false,
    scheduleFlush: () => () => undefined
  })
  const emit = (conv: string, event: ChatEvent): void => {
    board.observe(conv, CWD, event)
    po.observe(conv, event)
  }
  const userSays = (conv: string, text: string): Promise<void> => {
    clock += 61_000
    po.noteUserMessage(conv, CWD, text)
    return board.resumeTurn(conv, CWD)
  }
  const idle = async (conv: string): Promise<void> => {
    await board.settled(conv)
    await po.settled(conv)
    await board.turnClosed(conv)
    await po.settled(conv)
  }
  // A conversa A deixa o cartão "a fazer" no quadro do projeto.
  await userSays(A, 'anota o erro do login para depois')
  emit(A, { kind: 'task-list', items: [{ id: '1', content: 'Corrigir o erro do login', status: 'pending', activeForm: 'Corrigindo' }] })
  emit(A, result)
  await idle(A)
  return { emit, userSays, idle, card, prompts }
}

const isOpenOfB = (prompt: string): boolean => !prompt.includes('AÇÕES DESTE TURNO') && prompt.includes('arruma o erro do login')
const isCloseOfB = (prompt: string): boolean => prompt.includes('AÇÕES DESTE TURNO') && prompt.includes('arruma o erro do login')

describe('PO: pedido pelo chat sobre cartão de outra conversa', () => {
  it('a abertura põe o cartão em andamento e o fechamento o conclui pela resposta final', async () => {
    const w = await world(async (prompt, card) => {
      const id = (await card()).id
      if (isOpenOfB(prompt)) return `ANDAMENTO ${id} | o usuário pediu a correção pelo chat`
      return 'OK'
    })
    expect(boardItemStatus(await w.card())).toBe('pending')

    await w.userSays(B, 'arruma o erro do login')
    await w.idle(B)
    const line = `${(await w.card()).id} [a fazer] ${PO_FOREIGN_MARK}`
    expect(w.prompts.some((p) => isOpenOfB(p) && p.includes(line))).toBe(true)
    expect(boardItemStatus(await w.card())).toBe('in_progress')

    w.emit(B, reply('Corrigi o erro do login: a sessão agora renova o token. Testes verdes.'))
    w.emit(B, result)
    await w.idle(B)
    const done = await w.card()
    expect(boardItemStatus(done)).toBe('completed')
    expect(done.conversationId).toBe(A)
  })

  it('sem a abertura, o fechamento conclui o cartão "a fazer" que a resposta diz ter feito (e não o renomeia)', async () => {
    const w = await world(async (prompt, card) => {
      const id = (await card()).id
      if (isCloseOfB(prompt) && prompt.includes('Corrigi o erro do login')) {
        return `CONCLUIR ${id} | login corrigido
TITULO ${id} | Outro título | renomear`
      }
      return 'OK'
    })
    await w.userSays(B, 'arruma o erro do login')
    await w.idle(B)
    expect(boardItemStatus(await w.card())).toBe('pending')
    w.emit(B, reply('Corrigi o erro do login.'))
    w.emit(B, result)
    await w.idle(B)
    // Concluir vale; renomear o cartão de outra conversa, não.
    expect(await w.card()).toMatchObject({ poStatus: 'completed', poReason: 'login corrigido', poTitle: null })
  })

  it('adotado com PENDENTE volta para "a fazer" com o motivo', async () => {
    const w = await world(async (prompt, card) => {
      const id = (await card()).id
      if (isOpenOfB(prompt)) return `ANDAMENTO ${id} | pedido pelo chat`
      if (isCloseOfB(prompt)) return `PENDENTE ${id} | falta o teste no celular\nTITULO ${id} | Outro título | renomear`
      return 'OK'
    })
    await w.userSays(B, 'arruma o erro do login')
    await w.idle(B)
    w.emit(B, reply('Comecei a correção do login; falta o teste no celular.'))
    w.emit(B, result)
    await w.idle(B)
    const card = await w.card()
    expect(boardItemStatus(card)).toBe('pending')
    expect(card.poReason).toBe(`${BOARD_TURN_END_REASON.result} — falta o teste no celular`)
  })

  it('turno interrompido devolve o adotado para "a fazer"', async () => {
    const w = await world(async (prompt, card) => (isOpenOfB(prompt) ? `ANDAMENTO ${(await card()).id} | pedido pelo chat` : 'OK'))
    await w.userSays(B, 'arruma o erro do login')
    await w.idle(B)
    expect(boardItemStatus(await w.card())).toBe('in_progress')
    w.emit(B, { kind: 'result', id: 'r', isError: true, text: '', durationMs: 1 })
    await w.idle(B)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const card = await w.card()
    expect(boardItemStatus(card)).toBe('pending')
    expect(card.poReason).toBe(BOARD_TURN_END_REASON.error)
  })
})
