// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BOARD_TURN_END_REASON, type ChatEvent } from '../../shared/ipc'
import type { BoardItem, BoardPoWrite, PersistenceRepository } from '../persistence/types'
import { BOARD_RESUME_WINDOW_MS, boardItemsToResume } from './boardModel'
import { BoardService, RESUME_REASON } from './boardService'

// Pasta REAL: `projectId` resolve a identidade do projeto (ver boardService.test.ts).
const CWD = process.cwd()
const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 }
const error: ChatEvent = { kind: 'error', id: 'e', text: 'caiu' }

function card(patch: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'p1',
    projectCwd: CWD,
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'uma',
    sourceStatus: 'in_progress',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '2026-09-14T12:00:00.000Z',
    updatedAt: '2026-09-14T12:00:00.000Z',
    ...patch
  }
}

const demoted = (id: string, poAt: string, patch: Partial<BoardItem> = {}): BoardItem =>
  card({ id, poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result, poAt, ...patch })

/** Repositório que REFLETE as escritas do PO — a promoção e a reabertura leem
 *  o que a outra gravou, que é justamente a corrida que interessa aqui. */
function liveRepo(initial: BoardItem[]) {
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
    applyBoardPo: vi.fn(async (input: BoardPoWrite) => {
      writes.push(input)
      const current = cards.get(input.id)
      if (!current) throw new Error('sumiu')
      const next = {
        ...current,
        poStatus: input.poStatus ?? current.poStatus,
        poReason: input.poReason ?? current.poReason,
        poAt: new Date().toISOString()
      }
      cards.set(input.id, next)
      return { ...next }
    })
  } as unknown as PersistenceRepository
  return { repo, cards, writes }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('boardItemsToResume', () => {
  it('com a memória do fechamento, só os ids que ele rebaixou', () => {
    const items = [demoted('a', '2026-09-28T10:00:00Z'), demoted('b', '2026-09-28T10:00:01Z')]
    expect(boardItemsToResume(items, new Set(['a'])).map((i) => i.id)).toEqual(['a'])
    expect(boardItemsToResume(items, new Set())).toEqual([])
  })

  it('sem memória: o último rebaixamento e a mesma janela curta, nunca o órfão antigo', () => {
    const items = [
      demoted('velho', '2026-09-27T09:00:00.000Z'),
      demoted('a', '2026-09-28T10:00:00.000Z'),
      demoted('b', new Date(Date.parse('2026-09-28T10:00:00.000Z') + BOARD_RESUME_WINDOW_MS - 1).toISOString())
    ]
    expect(boardItemsToResume(items, null).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('nunca pega concluído, dispensado, movido pelo usuário ou "a fazer" que nunca começou', () => {
    const at = '2026-09-28T10:00:00Z'
    const items = [
      demoted('concluido', at, { poStatus: 'completed' }),
      demoted('dispensado', at, { dismissedAt: at }),
      demoted('movido', at, { poReason: 'o usuário moveu o cartão para "a fazer" pelo quadro' }),
      card({ id: 'nunca', sourceStatus: 'pending' })
    ]
    expect(boardItemsToResume(items, null)).toEqual([])
    expect(boardItemsToResume(items, new Set(items.map((i) => i.id)))).toEqual([])
  })
})

describe('BoardService.resumeTurn — promoção determinística', () => {
  it('"pode fazer" depois do turno que esperava o usuário: volta para em andamento, sem PO', async () => {
    const { repo, cards } = liveRepo([card({ id: 'a' })])
    const service = new BoardService({ repository: () => repo })

    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')
    expect(cards.get('a')).toMatchObject({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })

    await service.resumeTurn('conv-1', CWD)
    expect(cards.get('a')).toMatchObject({ poStatus: 'in_progress', poReason: RESUME_REASON })
  })

  it('também retoma o que o turno interrompido (error) deixou', async () => {
    const { repo, cards } = liveRepo([card({ id: 'a' })])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, error)
    await service.resumeTurn('conv-1', CWD)
    expect(cards.get('a')).toMatchObject({ poStatus: 'in_progress', poReason: RESUME_REASON })
  })

  it('só os rebaixados no turno IMEDIATAMENTE anterior — o órfão antigo fica', async () => {
    const { repo, cards } = liveRepo([
      demoted('orfao', '2026-09-20T10:00:00.000Z'),
      card({ id: 'a' })
    ])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, result)
    await service.resumeTurn('conv-1', CWD)
    expect(cards.get('a')?.poStatus).toBe('in_progress')
    expect(cards.get('orfao')?.poStatus).toBe('pending')
  })

  it('turno anterior que não rebaixou nada não ressuscita órfão de turno mais antigo', async () => {
    const { repo, cards } = liveRepo([demoted('orfao', new Date().toISOString())])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, result)
    await service.resumeTurn('conv-1', CWD)
    expect(cards.get('orfao')?.poStatus).toBe('pending')
  })

  it('espera o fechamento pendente, e a reabertura dele não desfaz a promoção', async () => {
    const { repo, cards } = liveRepo([card({ id: 'a' })])
    const po = deferred()
    const service = new BoardService({ repository: () => repo, poSettled: () => po.promise })

    service.observe('conv-1', CWD, result) // fechamento esperando o PO
    const resumed = service.resumeTurn('conv-1', CWD)
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Ainda esperando: nada foi escrito antes de o fechamento terminar.
    expect(cards.get('a')?.poStatus).toBeNull()

    po.resolve()
    await resumed
    expect(cards.get('a')).toMatchObject({ poStatus: 'in_progress', poReason: RESUME_REASON })
  })

  it('não promove se o turno desta mensagem já acabou enquanto esperava', async () => {
    const { repo, cards } = liveRepo([card({ id: 'a' })])
    const po = deferred()
    const service = new BoardService({ repository: () => repo, poSettled: () => po.promise })

    service.observe('conv-1', CWD, result)
    const resumed = service.resumeTurn('conv-1', CWD)
    service.observe('conv-1', CWD, result) // o turno novo terminou antes da promoção rodar
    po.resolve()
    await resumed
    await service.turnClosed('conv-1')
    expect(cards.get('a')).toMatchObject({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })
  })

  it('idempotente: duas mensagens seguidas promovem uma vez só', async () => {
    const { repo, writes } = liveRepo([card({ id: 'a' })])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, result)
    await service.resumeTurn('conv-1', CWD)
    await service.resumeTurn('conv-1', CWD)
    expect(writes.filter((w) => w.poStatus === 'in_progress')).toHaveLength(1)
  })

  it('ciclo encadeado: rebaixar → promover → rebaixar de novo → promover', async () => {
    const { repo, cards } = liveRepo([card({ id: 'a' })])
    const service = new BoardService({ repository: () => repo })
    for (let round = 0; round < 2; round++) {
      service.observe('conv-1', CWD, result)
      await service.turnClosed('conv-1')
      expect(cards.get('a')?.poStatus).toBe('pending')
      await service.resumeTurn('conv-1', CWD)
      expect(cards.get('a')?.poStatus).toBe('in_progress')
    }
  })

  it('quadro indisponível não lança', async () => {
    const service = new BoardService({ repository: () => null })
    service.observe('conv-1', CWD, result)
    await expect(service.resumeTurn('conv-1', CWD)).resolves.toBeUndefined()
  })
})
