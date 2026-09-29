// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOARD_TURN_END_REASON, type BoardConfig, type BoardItem, type ChatEvent } from '../../shared/ipc'
import { BoardService, RESUME_REASON } from '../board/boardService'
import type { BoardPoWrite, PersistenceRepository } from '../persistence/types'
import { Po } from './po'

/**
 * O ANDAMENTO da ABERTURA que chega atrasado.
 *
 * A abertura lê o quadro, consulta o modelo e só então escreve. Se, enquanto o
 * modelo pensa, o cartão é concluído — pelo CONCLUIR atrasado do fechamento
 * anterior, pelo usuário arrastando no quadro —, o ANDAMENTO que chega depois
 * foi decidido sobre um "a fazer" que já não existe. Aplicá-lo reabriria um
 * concluído por cima de uma decisão mais nova. A barreira que descarta
 * ANDAMENTO em cartão que não está "a fazer" (`rejectUnsafeOps`) tem que ver a
 * lista FRESCA, relida na hora de escrever — não a de antes da consulta.
 *
 * Quadro real (BoardService, com o teto de espera de produção) sobre um
 * repositório em memória que reflete as escritas, e relógio falso: o
 * fechamento responde aos 50 s, a abertura 20 s depois de perguntar.
 */

const CWD = process.cwd()
const CONV = 'conv-late-open'
const EXE_ID = 'bi-exe'
const EXE = 'Gerar o EXE do instalador'
const PO_WAIT_MS = 30_000
const CLOSE_ANSWER_MS = 50_000
const OPEN_ANSWER_MS = 20_000
const LATE_REASON = 'a resposta final mostra o EXE gerado'
const OPEN_REASON = 'o usuário voltou ao instalador'

afterEach(() => {
  vi.useRealTimers()
})

function card(patch: Partial<BoardItem> = {}): BoardItem {
  return {
    id: EXE_ID,
    projectId: 'p',
    projectCwd: CWD,
    conversationId: CONV,
    origin: 'agent',
    sourceId: '1',
    sourceTitle: EXE,
    sourceStatus: 'pending',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '2026-09-29T12:00:00.000Z',
    updatedAt: '2026-09-29T12:00:00.000Z',
    ...patch
  }
}

const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }

/** Repositório em memória com a semântica do `applyBoardPo` dos dois bancos:
 *  sem checagem de revisão nem de estado — campo omitido fica, campo dado
 *  sobrescreve, e `poAt` é o relógio de agora (o falso). */
function memoryRepo(initial: BoardItem[]) {
  const cards = new Map(initial.map((item) => [item.id, { ...item }]))
  const writes: BoardPoWrite[] = []
  const repo = {
    syncBoardItems: vi.fn(async () => []),
    listBoardItems: vi.fn(async (query: { conversationId?: string; includeDismissed?: boolean }) =>
      [...cards.values()]
        .filter((item) => !query.conversationId || item.conversationId === query.conversationId)
        .filter((item) => query.includeDismissed || item.dismissedAt === null)
        .map((item) => ({ ...item }))
    ),
    getBoardItem: vi.fn(async (id: string) => {
      const item = cards.get(id)
      return item ? { ...item } : null
    }),
    applyBoardPo: vi.fn(async (input: BoardPoWrite) => {
      writes.push(input)
      const current = cards.get(input.id)
      if (!current) throw new Error('sumiu')
      const next: BoardItem = {
        ...current,
        poTitle: input.poTitle === undefined ? current.poTitle : input.poTitle,
        poStatus: input.poStatus === undefined ? current.poStatus : input.poStatus,
        poReason: input.poReason === undefined ? current.poReason : input.poReason,
        poAt: new Date().toISOString()
      }
      cards.set(input.id, next)
      return { ...next }
    })
  } as unknown as PersistenceRepository
  return { repo, cards, writes }
}

/**
 * O fechamento responde `closeVerdict` aos 50 s. A abertura só pede ANDAMENTO
 * quando VIU o cartão "a fazer" no digest — e aí demora 20 s; vendo outra
 * coisa, responde OK na hora. É isso que garante que o ANDAMENTO do teste foi
 * decidido sobre a lista de ANTES da mudança. `thinking` resolve quando essa
 * consulta lenta começa.
 */
async function world(initial: BoardItem[], closeVerdict = 'OK') {
  const { repo, cards, writes } = memoryRepo(initial)
  const board = new BoardService({ repository: () => repo, poSettled: (id): Promise<void> => po.settled(id) })
  // A identidade do projeto (git, E/S de verdade) antes de o relógio virar falso.
  expect(await board.projectId(CWD)).toBeTruthy()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })

  const later = (text: string, ms: number): Promise<string> =>
    new Promise<string>((resolve) => setTimeout(() => resolve(text), ms))
  let startedThinking: () => void = () => undefined
  const thinking = new Promise<void>((resolve) => {
    startedThinking = resolve
  })
  // O cooldown do PO anda no relógio dele, separado do falso: cada mensagem do
  // usuário é uma análise nova, nunca adiada.
  let clock = 1_000_000
  const po: Po = new Po({
    config,
    board,
    now: () => clock,
    ask: async (prompt) => {
      if (prompt.includes('AÇÕES DESTE TURNO')) return later(closeVerdict, CLOSE_ANSWER_MS)
      if (!prompt.includes(`${EXE_ID} [a fazer]`)) return 'OK'
      startedThinking()
      return later(`ANDAMENTO ${EXE_ID} | ${OPEN_REASON}`, OPEN_ANSWER_MS)
    },
    gateActive: async () => false,
    scheduleFlush: () => () => undefined,
    listConvTasks: async () => [],
    linkableLedgerTasks: async () => []
  })
  const say = (text: string): void => {
    clock += 61_000
    po.noteUserMessage(CONV, CWD, text)
  }
  // A ordem do tee do index.ts: quadro primeiro, PO depois.
  const endTurn = (): void => {
    board.observe(CONV, CWD, result)
    po.observe(CONV, result)
  }
  return { board, po, cards, writes, thinking, say, endTurn }
}

describe('Po — ANDAMENTO da abertura que chega depois de o cartão ser concluído', () => {
  it('o CONCLUIR atrasado do fechamento conclui no meio da consulta da abertura; o ANDAMENTO que chega depois não reabre', async () => {
    const w = await world([card({ sourceStatus: 'in_progress' })], `CONCLUIR ${EXE_ID} | ${LATE_REASON}`)

    // O turno de trabalho: a abertura vê o cartão em andamento e responde OK.
    w.say('gera o EXE do instalador')
    w.endTurn()

    // 30 s: o teto do fechamento passou com o modelo do PO ainda pensando.
    await vi.advanceTimersByTimeAsync(PO_WAIT_MS)
    await w.board.turnClosed(CONV)
    expect(w.cards.get(EXE_ID)).toMatchObject({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })

    // 35 s: o usuário volta ao assunto. A abertura lê o "a fazer" e vai ao
    // modelo; a promoção determinística do quadro vem logo atrás.
    await vi.advanceTimersByTimeAsync(5_000)
    w.say('e o instalador?')
    await w.thinking
    await w.board.resumeTurn(CONV, CWD)
    expect(w.cards.get(EXE_ID)).toMatchObject({ poStatus: 'in_progress', poReason: RESUME_REASON })

    // 50 s: o CONCLUIR atrasado do fechamento grava — é a decisão mais nova.
    await vi.advanceTimersByTimeAsync(CLOSE_ANSWER_MS - PO_WAIT_MS - 5_000)
    expect(w.cards.get(EXE_ID)).toMatchObject({ poStatus: 'completed', poReason: LATE_REASON })

    // 55 s: o ANDAMENTO da abertura chega, decidido sobre o "a fazer" dos 35 s.
    await vi.advanceTimersByTimeAsync(OPEN_ANSWER_MS)
    await w.po.settled(CONV)
    expect(w.cards.get(EXE_ID)).toMatchObject({ poStatus: 'completed', poReason: LATE_REASON })
    expect(w.writes.map((write) => write.poStatus)).toEqual(['pending', 'in_progress', 'completed'])
  })

  it('o usuário conclui pelo quadro enquanto a abertura consulta o modelo: o ANDAMENTO que chega depois é descartado', async () => {
    const w = await world([card()])

    w.say('pode fazer')
    await w.thinking
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await w.board.move(EXE_ID, 'completed')).toEqual({ ok: true })

    await vi.advanceTimersByTimeAsync(OPEN_ANSWER_MS)
    await w.po.settled(CONV)

    expect(w.cards.get(EXE_ID)?.poStatus).toBe('completed')
    expect(w.writes).toEqual([expect.objectContaining({ id: EXE_ID, poStatus: 'completed', actor: 'user' })])
  })

  it('controle: nada mudou enquanto o modelo pensava — o cartão continua "a fazer" e o ANDAMENTO atrasado vale', async () => {
    const w = await world([card()])

    w.say('pode fazer')
    await w.thinking
    await vi.advanceTimersByTimeAsync(OPEN_ANSWER_MS)
    await w.po.settled(CONV)

    expect(w.cards.get(EXE_ID)).toMatchObject({ poStatus: 'in_progress', poReason: OPEN_REASON })
    expect(w.writes).toEqual([{ id: EXE_ID, poStatus: 'in_progress', poReason: OPEN_REASON }])
  })
})
