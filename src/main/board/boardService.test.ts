// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent, TaskItem } from '../../shared/ipc'
import type { BoardItem, BoardPoWrite, BoardSyncInput, PersistenceRepository } from '../persistence/types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardService, toSourceItems } from './boardService'

// Pasta REAL: `projectId` resolve a identidade do projeto e devolve '' quando a
// pasta não existe — com um caminho inventado, nada seria gravado.
const CWD = process.cwd()

function task(id: string, content: string, status: TaskItem['status'], activeForm = ''): TaskItem {
  return { id, content, status, activeForm }
}

function taskList(items: TaskItem[]): ChatEvent {
  return { kind: 'task-list', items }
}

/** O fim normal do turno — o gatilho do fechamento do quadro. */
function turnResult(): ChatEvent {
  return { kind: 'result', id: 'r1', isError: false, text: '', durationMs: 1 }
}

function fakeRepo(overrides: Partial<PersistenceRepository> = {}) {
  const syncs: BoardSyncInput[] = []
  const repo = {
    syncBoardItems: vi.fn(async (input: BoardSyncInput) => {
      syncs.push(input)
      return []
    }),
    listBoardItems: vi.fn(async () => []),
    ...overrides
  } as unknown as PersistenceRepository
  return { repo, syncs }
}

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

/** Repositório fake com quadro: `listBoardItems` devolve os cartões dados e
 *  `applyBoardPo` registra a escrita do PO, que é o que a reabertura usa. */
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

describe('toSourceItems', () => {
  it('traduz o TaskItem do CLI preservando a ordem como seq', () => {
    const items = toSourceItems([task('1', 'uma', 'completed', 'Fazendo uma'), task('2', 'duas', 'pending')])
    expect(items).toEqual([
      { sourceId: '1', title: 'uma', status: 'completed', activeForm: 'Fazendo uma', seq: 0 },
      { sourceId: '2', title: 'duas', status: 'pending', activeForm: null, seq: 1 }
    ])
  })
})

describe('BoardService', () => {
  it('grava o snapshot autoritativo (`task-list`) no quadro', async () => {
    const { repo, syncs } = fakeRepo()
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, taskList([task('1', 'uma', 'pending')]))
    await service.settled('conv-1')

    expect(syncs).toHaveLength(1)
    expect(syncs[0]).toMatchObject({ conversationId: 'conv-1', projectCwd: CWD })
    expect(syncs[0].items[0]).toMatchObject({ sourceId: '1', title: 'uma' })
    expect(syncs[0].projectId).toBeTruthy()
  })

  it('ignora os eventos incrementais — o quadro só segue o snapshot', async () => {
    const { repo, syncs } = fakeRepo()
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, { kind: 'tool-use', id: 't1', name: 'TaskCreate', input: {}, parentToolUseId: null })
    service.observe('conv-1', CWD, { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 })
    await service.settled('conv-1')
    expect(syncs).toHaveLength(0)
  })

  it('sem repositório autoritativo não grava e não lança', async () => {
    const service = new BoardService({ repository: () => null })
    service.observe('conv-1', CWD, taskList([task('1', 'uma', 'pending')]))
    await expect(service.settled('conv-1')).resolves.toBeUndefined()
    // `null`, não `[]`: "não consegui ler" é diferente de "está vazio", e a
    // tela diz coisas diferentes para cada um.
    await expect(service.list(CWD)).resolves.toBeNull()
  })

  it('falha do banco degrada em silêncio — o chat não pode quebrar por causa do quadro', async () => {
    const { repo } = fakeRepo({
      syncBoardItems: vi.fn(async () => {
        throw new Error('banco fora do ar')
      }) as unknown as PersistenceRepository['syncBoardItems']
    })
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, taskList([task('1', 'uma', 'pending')]))
    await expect(service.settled('conv-1')).resolves.toBeUndefined()
  })

  it('duas rajadas da mesma conversa são serializadas, não concorrentes', async () => {
    const order: string[] = []
    let release: (() => void) | null = null
    const repo = {
      syncBoardItems: vi.fn(async (input: BoardSyncInput) => {
        order.push(`inicio:${input.items[0]?.sourceId}`)
        if (!release) await new Promise<void>((resolve) => (release = resolve))
        order.push(`fim:${input.items[0]?.sourceId}`)
        return []
      }),
      listBoardItems: vi.fn(async () => [])
    } as unknown as PersistenceRepository

    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, taskList([task('1', 'uma', 'pending')]))
    service.observe('conv-1', CWD, taskList([task('2', 'duas', 'pending')]))
    await vi.waitFor(() => expect(release).not.toBeNull())
    release!()
    await service.settled('conv-1')

    expect(order).toEqual(['inicio:1', 'fim:1', 'inicio:2', 'fim:2'])
  })

  it('avisa a tela quando o quadro muda', async () => {
    const { repo } = fakeRepo()
    const onChanged = vi.fn()
    const service = new BoardService({ repository: () => repo, onChanged })
    service.observe('conv-1', CWD, taskList([task('1', 'uma', 'pending')]))
    await service.settled('conv-1')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('pasta que não existe NÃO ganha id inventado — id falso faria a tela dizer "nenhuma tarefa"', async () => {
    const service = new BoardService({ repository: () => null })
    expect(await service.projectId('C:/pasta/que/nao/existe')).toBe('')
  })

  it('cartão em andamento no fim do turno volta para "a fazer", com o motivo', async () => {
    const { repo, applied } = boardRepo([card({ id: 'bi-andando', sourceStatus: 'in_progress' })])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, turnResult())
    await service.turnClosed('conv-1')

    expect(applied).toEqual([
      { id: 'bi-andando', poStatus: 'pending', poReason: 'o turno terminou sem concluir esta tarefa' }
    ])
  })

  it('turno que morreu no meio grava o motivo da interrupção, não o do fim normal', async () => {
    const { repo, applied } = boardRepo([card({ sourceStatus: 'in_progress' })])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, { kind: 'error', id: 'e1', text: 'estourou' })
    await service.turnClosed('conv-1')

    expect(applied[0].poReason).toBe('o turno foi interrompido com esta tarefa em andamento')
  })

  it('o que já está concluído não é reaberto — nem pelo agente, nem pelo PO', async () => {
    const { repo, applied } = boardRepo([
      card({ id: 'bi-pronto', sourceStatus: 'completed' }),
      card({ id: 'bi-po', sourceStatus: 'in_progress', poStatus: 'completed', poReason: 'o agente esqueceu' }),
      card({ id: 'bi-a-fazer', sourceStatus: 'pending' })
    ])
    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, turnResult())
    await service.turnClosed('conv-1')

    expect(applied).toEqual([])
  })

  it('a reabertura só acontece DEPOIS do PO — antes dele, desfaria o "concluído" que ele ia gravar', async () => {
    const { repo, applied } = boardRepo([card({ sourceStatus: 'in_progress' })])
    let releasePo: (() => void) | null = null
    const service = new BoardService({
      repository: () => repo,
      poSettled: () => new Promise<void>((resolve) => (releasePo = resolve))
    })
    service.observe('conv-1', CWD, turnResult())

    await vi.waitFor(() => expect(releasePo).not.toBeNull())
    expect(applied).toEqual([]) // o PO ainda está analisando
    releasePo!()
    await service.turnClosed('conv-1')

    expect(applied).toHaveLength(1)
  })

  it('cartão que a rodada de ABERTURA já promoveu de volta, enquanto a reabertura ainda esperava o PO, não é derrubado de novo', async () => {
    // A reabertura espera o PO (waitForPo). É exatamente essa janela que, na
    // vida real, dá tempo da PRÓXIMA mensagem do usuário chegar e o PO da
    // abertura promover o mesmo cartão de volta para "em andamento" antes da
    // releitura da reabertura acontecer — sem o corte por `poAt`, a
    // reabertura desfaria essa promoção e o cartão ficava preso em "a fazer".
    const cards = [card({ sourceStatus: 'in_progress' })]
    const { repo, applied } = boardRepo(cards)
    const service = new BoardService({
      repository: () => repo,
      poSettled: async () => {
        cards[0] = {
          ...cards[0],
          poStatus: 'in_progress',
          poReason: 'a mensagem seguinte retomou o trabalho',
          poAt: new Date(Date.now() + 5000).toISOString()
        }
      }
    })
    service.observe('conv-1', CWD, turnResult())
    await service.turnClosed('conv-1')

    expect(applied).toEqual([])
  })

  it('PO que nunca responde não segura o fechamento para sempre', async () => {
    const { repo, applied } = boardRepo([card({ sourceStatus: 'in_progress' })])
    const service = new BoardService({
      repository: () => repo,
      poSettled: () => new Promise<void>(() => undefined), // nunca resolve
      poWaitMs: 5
    })
    service.observe('conv-1', CWD, turnResult())
    await service.turnClosed('conv-1')

    expect(applied).toHaveLength(1)
  })

  it('PO que falha não impede a reabertura', async () => {
    const { repo, applied } = boardRepo([card({ sourceStatus: 'in_progress' })])
    const service = new BoardService({
      repository: () => repo,
      poSettled: () => Promise.reject(new Error('modelo fora do ar'))
    })
    service.observe('conv-1', CWD, turnResult())
    await service.turnClosed('conv-1')

    expect(applied).toHaveLength(1)
  })

  it('sem repositório o fechamento não faz nada e não lança', async () => {
    const service = new BoardService({ repository: () => null })
    service.observe('conv-1', CWD, turnResult())
    await expect(service.turnClosed('conv-1')).resolves.toBeUndefined()
  })

  it('falha ao gravar a reabertura degrada em silêncio', async () => {
    const { repo } = boardRepo([card({ sourceStatus: 'in_progress' })])
    const failing = {
      ...repo,
      applyBoardPo: vi.fn(async () => {
        throw new Error('banco fora do ar')
      })
    } as unknown as PersistenceRepository
    const service = new BoardService({ repository: () => failing })
    service.observe('conv-1', CWD, turnResult())
    await expect(service.turnClosed('conv-1')).resolves.toBeUndefined()
  })

  it('o fechamento espera a fila de escrita do quadro — senão releria um estado velho', async () => {
    const order: string[] = []
    const { applied } = boardRepo([card({ sourceStatus: 'in_progress' })])
    const repo = {
      syncBoardItems: vi.fn(async () => {
        await Promise.resolve()
        order.push('sync')
        return []
      }),
      listBoardItems: vi.fn(async () => [card({ sourceStatus: 'in_progress' })]),
      applyBoardPo: vi.fn(async (input: BoardPoWrite) => {
        order.push('reabertura')
        applied.push(input)
        return card({ id: input.id })
      })
    } as unknown as PersistenceRepository

    const service = new BoardService({ repository: () => repo })
    service.observe('conv-1', CWD, taskList([task('1', 'uma', 'in_progress')]))
    service.observe('conv-1', CWD, turnResult())
    await service.turnClosed('conv-1')

    expect(order).toEqual(['sync', 'reabertura'])
  })

  it('pasta real sem git ainda tem id estável, e o cache o reaproveita', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-code-board-cwd-'))
    try {
      const service = new BoardService({ repository: () => null })
      const first = await service.projectId(dir)
      expect(first).toBeTruthy()
      expect(await service.projectId(dir)).toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
