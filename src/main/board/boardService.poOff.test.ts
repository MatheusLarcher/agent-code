// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BOARD_TURN_END_REASON, type ChatEvent } from '../../shared/ipc'
import type { BoardItem, BoardPoWrite, PersistenceRepository } from '../persistence/types'
import { BoardService } from './boardService'

// PO desligado: o quadro é só do agente principal. Nem o fim do turno rebaixa o
// que ficou "fazendo", nem a mensagem do usuário promove o que foi rebaixado.

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

function repoWith(items: BoardItem[]) {
  const writes: BoardPoWrite[] = []
  const repo = {
    syncBoardItems: vi.fn(async () => []),
    listBoardItems: vi.fn(async () => items.map((item) => ({ ...item }))),
    applyBoardPo: vi.fn(async (input: BoardPoWrite) => {
      writes.push(input)
      return { ...items[0] }
    })
  } as unknown as PersistenceRepository
  return { repo, writes }
}

describe('BoardService — PO desligado', () => {
  it('o fim do turno (result ou error) não rebaixa o cartão em andamento', async () => {
    const { repo, writes } = repoWith([card()])
    const service = new BoardService({ repository: () => repo, poEnabled: () => false })
    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')
    service.observe('conv-1', CWD, error)
    await service.turnClosed('conv-1')
    expect(writes).toEqual([])
  })

  it('a mensagem do usuário não promove o cartão rebaixado', async () => {
    const rebaixado = card({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result, poAt: new Date().toISOString() })
    const { repo, writes } = repoWith([rebaixado])
    const service = new BoardService({ repository: () => repo, poEnabled: () => false })
    await service.resumeTurn('conv-1', CWD)
    expect(writes).toEqual([])
  })

  it('o snapshot do agente continua gravando', async () => {
    const { repo } = repoWith([])
    const service = new BoardService({ repository: () => repo, poEnabled: () => false })
    service.observe('conv-1', CWD, { kind: 'task-list', items: [{ id: '1', content: 'a', status: 'in_progress', activeForm: 'a' }] })
    await service.settled('conv-1')
    expect(repo.syncBoardItems).toHaveBeenCalledOnce()
  })

  it('PO ligado: o fechamento continua rebaixando (o comportamento de sempre)', async () => {
    const { repo, writes } = repoWith([card()])
    const service = new BoardService({ repository: () => repo, poEnabled: () => true })
    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')
    expect(writes).toHaveLength(1)
  })
})
