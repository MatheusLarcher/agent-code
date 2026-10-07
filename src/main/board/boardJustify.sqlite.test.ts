// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BOARD_TURN_END_REASON,
  boardItemAwaitingBadge,
  type BoardConfig,
  type BoardItem,
  type ChatEvent
} from '../../shared/ipc'
import type { PersistenceRepository } from '../persistence/types'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { Po } from '../po/po'
import { PO_DEFAULT_COMPLETE_REASON } from '../po/poCloseDefault'
import { PO_RETURNED_SECTION } from '../po/poPrompt'
import { DISMISS_BY_USER, EXPIRE_BY } from './boardModel'
import { BoardService } from './boardService'

/**
 * Ponta a ponta no SQLite real: o PENDENTE do PO troca a frase genérica do fim
 * de turno pelo motivo concreto, o rebaixamento é gravado como `system` e
 * mantém a justificativa, e o selo/retomada continuam funcionando.
 */

const CWD = process.cwd()
const CONV = 'conv-justify'
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function world(ask: (prompt: string) => Promise<string>) {
  const cache = await mkdtemp(join(tmpdir(), 'agent-code-justify-'))
  tempDirs.push(cache)
  const repository = new SqliteRepository(cache, join(cache, 'agent-code.db'), 'device-a')
  await repository.initialize()
  const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })
  const board = new BoardService({
    repository: () => repository,
    poSettled: (id): Promise<void> => po.settled(id),
    poWaitMs: 2_000
  })
  let clock = 1_000_000
  const po: Po = new Po({
    config,
    board,
    now: () => clock,
    ask,
    gateActive: async () => false,
    scheduleFlush: () => () => undefined,
    decisionLog: () => undefined
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
  return { emit, userSays, idle, cards, repository }
}

const taskList: ChatEvent = {
  kind: 'task-list',
  items: [{ id: '1', content: 'Implementar a fase 1', status: 'in_progress', activeForm: 'Implementando' }]
}
const reply: ChatEvent = { kind: 'assistant-text', id: 'a', text: 'Código pronto. Falta commitar. Commito?', final: true }
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

/** Responde PENDENTE para o primeiro id da seção de devolvidos do digest. A
 *  ÚLTIMA ocorrência do rótulo: as regras do prompt também o citam. */
async function pendente(prompt: string): Promise<string> {
  const digest = prompt.split('\n---\n').at(-1) ?? ''
  const at = digest.lastIndexOf(PO_RETURNED_SECTION)
  const id = at >= 0 ? /\n- (\S+)/.exec(digest.slice(at))?.[1] : undefined
  return id ? `PENDENTE ${id} | falta commitar a fase 1` : 'OK'
}

describe('PENDENTE + fim de turno no SQLite real', () => {
  it('o cartão devolvido leva o motivo concreto, o rebaixamento é "system" e o selo continua', async () => {
    const w = await world(pendente)
    await w.userSays('implementa a fase 1')
    w.emit(taskList)
    w.emit(reply)
    w.emit(result)
    await w.idle()

    const [card] = await w.cards()
    expect(card.poStatus).toBe('pending')
    expect(card.poReason).toBe(`${BOARD_TURN_END_REASON.result} — falta commitar a fase 1`)
    expect(boardItemAwaitingBadge(card)?.label).toBe('Aguardando você')

    const events = await w.repository.listBoardItemEvents(card.id)
    const tail = events.filter((e) => e.kind === 'justified' || e.kind === 'status_changed').slice(-2)
    expect(tail).toEqual([
      expect.objectContaining({ kind: 'justified', actor: 'po', note: 'falta commitar a fase 1' }),
      expect.objectContaining({
        kind: 'status_changed',
        actor: 'system',
        fromStatus: 'in_progress',
        toStatus: 'pending',
        note: `${BOARD_TURN_END_REASON.result} — falta commitar a fase 1`
      })
    ])

    // A próxima mensagem retoma o cartão justificado — também como "system".
    await w.userSays('pode commitar')
    await w.idle()
    const resumed = (await w.repository.listBoardItemEvents(card.id)).filter((e) => e.kind === 'status_changed').at(-1)
    expect(resumed).toMatchObject({ actor: 'system', toStatus: 'in_progress', note: 'o usuário retomou a conversa' })
  })

  it('sem PENDENTE (o PO respondeu OK) o cartão devolvido vira concluído pelo padrão, e nada é rebaixado', async () => {
    const w = await world(async () => 'OK')
    await w.userSays('implementa a fase 1')
    w.emit(taskList)
    w.emit(reply)
    w.emit(result)
    await w.idle()

    const [card] = await w.cards()
    expect(card).toMatchObject({ poStatus: 'completed', poReason: PO_DEFAULT_COMPLETE_REASON })
    expect(boardItemAwaitingBadge(card)).toBeNull()
    const changes = (await w.repository.listBoardItemEvents(card.id)).filter((e) => e.kind === 'status_changed')
    expect(changes).toEqual([expect.objectContaining({ actor: 'po', fromStatus: 'in_progress', toStatus: 'completed' })])
  })

  it('sem veredito (modelo do PO fora do ar) fica a frase fixa de sempre: nada conclui sem alguém ler', async () => {
    const w = await world(async () => {
      throw new Error('modelo indisponível')
    })
    await w.userSays('implementa a fase 1')
    w.emit(taskList)
    w.emit(reply)
    w.emit(result)
    await w.idle()

    const [card] = await w.cards()
    expect(card).toMatchObject({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })
  })

  it('Stop do usuário (result com erro): o PO não fecha o turno e o cartão volta "Interrompido"', async () => {
    const ask = vi.fn(async (_prompt: string) => 'OK')
    const w = await world(ask)
    await w.userSays('implementa a fase 1')
    await w.idle()
    const opens = ask.mock.calls.length
    w.emit(taskList)
    w.emit(reply)
    w.emit({ kind: 'result', id: 'r', isError: true, text: 'error_during_execution', durationMs: 1 })
    await w.idle()

    expect(ask.mock.calls.length).toBe(opens)
    const [card] = await w.cards()
    expect(card).toMatchObject({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.error })
    expect(boardItemAwaitingBadge(card)?.label).toBe('Interrompido')
  })
})

describe('BoardService — motivo de dispensar e da expiração', () => {
  function oldCompleted(id: string): BoardItem {
    return {
      id,
      projectId: 'p',
      projectCwd: CWD,
      conversationId: 'c',
      origin: 'agent',
      sourceId: id,
      sourceTitle: id,
      sourceStatus: 'completed',
      activeForm: null,
      seq: 0,
      poTitle: null,
      poNote: null,
      poStatus: null,
      poReason: null,
      poAt: null,
      dismissedAt: null,
      revision: 1,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z'
    }
  }

  it('o clique é do usuário (actor user); a expiração, "concluído há mais de 5 dias"', async () => {
    const items = Array.from({ length: 6 }, (_, i) => oldCompleted(`bi-${i}`))
    const dismissBoardItem = vi.fn(async (id: string) => ({ ...oldCompleted(id), projectId: 'p' }))
    const repository = {
      listBoardItems: vi.fn(async () => items),
      dismissBoardItem
    } as unknown as PersistenceRepository
    const board = new BoardService({ repository: () => repository })

    await board.dismiss('bi-x', true)
    await board.dismiss('bi-x', false)
    expect(dismissBoardItem).toHaveBeenNthCalledWith(1, 'bi-x', true, DISMISS_BY_USER.dismiss)
    expect(dismissBoardItem).toHaveBeenNthCalledWith(2, 'bi-x', false, DISMISS_BY_USER.restore)

    await board.list(CWD)
    expect(dismissBoardItem).toHaveBeenCalledWith('bi-0', true, EXPIRE_BY)
    expect(EXPIRE_BY).toEqual({ actor: 'system', note: 'concluído há mais de 5 dias' })
    expect(DISMISS_BY_USER.dismiss).toEqual({ actor: 'user', note: 'você dispensou o cartão' })
  })
})
