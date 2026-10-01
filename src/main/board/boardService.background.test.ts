// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BackgroundTask, ChatEvent } from '../../shared/ipc'
import type { BoardItem, BoardPoWrite, PersistenceRepository } from '../persistence/types'
import { BoardService } from './boardService'

/**
 * O fim de turno com trabalho DELEGADO: o agente principal pôs um subagente (ou
 * um Bash) para rodar em segundo plano e o turno dele acabou. O `result` chega,
 * mas o trabalho do cartão continua — rebaixar para "a fazer" seria mentir.
 * A fonte é o snapshot `background-tasks` do SDK (lista vazia = nada rodando).
 */

// Pasta REAL: `projectId` resolve a identidade do projeto e devolve '' quando a
// pasta não existe — com um caminho inventado, nada seria gravado.
const CWD = process.cwd()

const result: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: '', durationMs: 1 }
const subagente: BackgroundTask = { id: 'bg-1', type: 'local_agent', description: 'Implementar a exportação de XML' }

function background(tasks: BackgroundTask[]): ChatEvent {
  return { kind: 'background-tasks', tasks }
}

function card(patch: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-andando',
    projectId: 'p1',
    projectCwd: CWD,
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'exportação de XML',
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
    createdAt: '2026-09-29T12:00:00.000Z',
    updatedAt: '2026-09-29T12:00:00.000Z',
    ...patch
  }
}

function boardRepo(cards: BoardItem[]) {
  const applied: BoardPoWrite[] = []
  const repo = {
    syncBoardItems: vi.fn(async () => []),
    listBoardItems: vi.fn(async () => cards),
    applyBoardPo: vi.fn(async (input: BoardPoWrite) => {
      applied.push(input)
      return card({ id: input.id })
    })
  } as unknown as PersistenceRepository
  return { repo, applied }
}

describe('BoardService — fim de turno com trabalho em segundo plano', () => {
  it('com subagente rodando no instante do result, o cartão em andamento NÃO volta para "a fazer"', async () => {
    const { repo, applied } = boardRepo([card()])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, background([subagente]))
    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')

    expect(applied).toEqual([])
  })

  it('quando a última tarefa de segundo plano termina, o próximo result fecha o turno como sempre', async () => {
    const { repo, applied } = boardRepo([card()])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, background([subagente]))
    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')
    expect(applied).toEqual([])

    // O subagente terminou (snapshot vazio) e o agente principal respondeu.
    service.observe('conv-1', CWD, background([]))
    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')
    expect(applied).toEqual([
      { id: 'bi-andando', poStatus: 'pending', poReason: 'o turno terminou sem concluir esta tarefa', actor: 'system' }
    ])
  })

  it('o que conta é o snapshot no instante do result — terminar DEPOIS não desfaz a decisão', async () => {
    const { repo, applied } = boardRepo([card()])
    const service = new BoardService({ repository: () => repo, poSettled: async () => undefined })
    service.observe('conv-1', CWD, background([subagente]))
    service.observe('conv-1', CWD, result)
    // O snapshot zera ainda no mesmo tick, antes de a fila de fechamento andar.
    service.observe('conv-1', CWD, background([]))
    await service.turnClosed('conv-1')

    expect(applied).toEqual([])
  })

  it('o snapshot é por conversa: a tarefa de outra conversa não segura este fechamento', async () => {
    const { repo, applied } = boardRepo([card()])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-2', CWD, background([subagente]))
    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')

    expect(applied).toHaveLength(1)
  })

  it('turno que MORREU (error) rebaixa mesmo com snapshot não vazio — o snapshot pode ter ficado velho', async () => {
    const { repo, applied } = boardRepo([card()])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, background([subagente]))
    service.observe('conv-1', CWD, { kind: 'error', id: 'e1', text: 'estourou' })
    await service.turnClosed('conv-1')

    expect(applied).toHaveLength(1)
  })

  it('o fechamento delegado não deixa a promoção seguinte reabrir o rebaixamento de um turno antigo', async () => {
    const cards = [card()]
    const { repo, applied } = boardRepo(cards)
    const service = new BoardService({ repository: () => repo })
    // Turno 1 termina sem nada em segundo plano: o cartão é rebaixado.
    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')
    expect(applied).toHaveLength(1)
    cards[0] = card({ poStatus: 'pending', poReason: 'o turno terminou sem concluir esta tarefa', poAt: new Date().toISOString() })

    // Turno 2 delega e termina: nada rebaixado AGORA — então a próxima mensagem
    // não tem o que promover (o "a fazer" é do turno 1, não deste fechamento).
    service.observe('conv-1', CWD, background([subagente]))
    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')
    await service.resumeTurn('conv-1', CWD)

    expect(applied).toHaveLength(1)
  })

  it('dispose esquece o snapshot da conversa', async () => {
    const { repo, applied } = boardRepo([card()])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, background([subagente]))
    service.dispose('conv-1')
    service.observe('conv-1', CWD, result)
    await service.turnClosed('conv-1')

    expect(applied).toHaveLength(1)
  })
})
