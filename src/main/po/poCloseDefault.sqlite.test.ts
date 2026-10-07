// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BOARD_TURN_END_REASON, boardItemStatus, type BoardConfig, type BoardItem, type ChatEvent } from '../../shared/ipc'
import { BoardService } from '../board/boardService'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { Po } from './po'
import { PO_DEFAULT_COMPLETE_REASON } from './poCloseDefault'

/**
 * O padrão "entregue = concluído" de ponta a ponta no SQLite real, nos caminhos
 * que o fechamento normal não cobre: a rodada que cai no cooldown e roda pela
 * fila DEPOIS de o fim do turno já ter rebaixado o cartão, e a rodada da fila
 * que encontra um turno novo rodando.
 */

const CWD = process.cwd()
const CONV = 'conv-default'
const tempDirs: string[] = []
const repositories: SqliteRepository[] = []

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** O plano do agente: a fase 1 (já concluída) e, quando há, o commit. */
const taskList = (commit?: 'in_progress' | 'completed'): ChatEvent => ({
  kind: 'task-list',
  items: [
    { id: '1', content: 'Implementar a fase 1', status: 'completed', activeForm: '' },
    ...(commit ? [{ id: '2', content: 'Commitar a fase 1', status: commit, activeForm: '' }] : [])
  ]
})
const reply = (text: string): ChatEvent => ({ kind: 'assistant-text', id: 'a', text, final: true })
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

async function world(ask: (prompt: string) => Promise<string>) {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-default-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  repositories.push(repository)
  const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })
  const board = new BoardService({ repository: () => repository, poSettled: (id): Promise<void> => po.settled(id), poWaitMs: 2_000 })
  let clock = 1_000_000
  // O flush do cooldown fica guardado para o teste disparar quando quiser.
  const flushes: (() => void)[] = []
  const po: Po = new Po({
    config,
    board,
    now: () => clock,
    ask,
    gateActive: async () => false,
    listConvTasks: async () => [],
    scheduleFlush: (_delay, fn) => {
      flushes.push(fn)
      return () => undefined
    }
  })
  const emit = (event: ChatEvent): void => {
    board.observe(CONV, CWD, event)
    po.observe(CONV, event)
  }
  const userSays = (text: string, afterMs: number): Promise<void> => {
    clock += afterMs
    po.noteUserMessage(CONV, CWD, text)
    return board.resumeTurn(CONV, CWD)
  }
  const idle = async (): Promise<void> => {
    await board.settled(CONV)
    await po.settled(CONV)
    await board.turnClosed(CONV)
    await po.settled(CONV)
  }
  const flushAll = async (): Promise<void> => {
    for (const fn of flushes.splice(0)) fn()
    await idle()
  }
  const cards = async (): Promise<BoardItem[]> => (await board.list(CWD, { conversationId: CONV })) ?? []
  return { emit, userSays, idle, flushAll, cards }
}

describe('padrão do fechamento — rodadas da fila do cooldown (SQLite real)', () => {
  it('fechamento no cooldown: o fim do turno rebaixa, e a rodada da fila conclui pelo padrão', async () => {
    const w = await world(async () => 'OK')
    await w.userSays('implementa a fase 1', 61_000)
    w.emit(taskList())
    w.emit(result)
    await w.idle()

    // "commita" logo depois: o fechamento deste turno cai no cooldown de 60 s.
    await w.userSays('commita', 20_000)
    w.emit(taskList('in_progress'))
    w.emit(reply('Commit feito: abc123 "feat: fase 1". Quer que eu dê push?'))
    w.emit(result)
    await w.idle()
    const commit = (await w.cards()).find((c) => c.sourceTitle === 'Commitar a fase 1') as BoardItem
    expect(commit).toMatchObject({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })

    await w.flushAll()
    const after = (await w.cards()).find((c) => c.sourceTitle === 'Commitar a fase 1') as BoardItem
    expect(after).toMatchObject({ poStatus: 'completed', poReason: PO_DEFAULT_COMPLETE_REASON })
  })

  it('a rodada da fila que encontra um turno NOVO rodando não conclui o que está em andamento', async () => {
    const w = await world(async () => 'OK')
    await w.userSays('implementa a fase 1', 61_000)
    w.emit(taskList())
    w.emit(result)
    await w.idle()

    await w.userSays('commita', 20_000)
    w.emit(taskList('in_progress'))
    w.emit(result)
    await w.idle()
    // O usuário já mandou outra mensagem: a retomada põe o cartão de volta em
    // andamento, e o agente está trabalhando nele agora.
    await w.userSays('na verdade, commita só o src/', 5_000)
    w.emit(taskList('in_progress'))
    await w.flushAll()

    const commit = (await w.cards()).find((c) => c.sourceTitle === 'Commitar a fase 1') as BoardItem
    expect(boardItemStatus(commit)).toBe('in_progress')
  })
})
