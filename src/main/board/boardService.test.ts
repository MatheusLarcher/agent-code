// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ChatEvent, TaskItem } from '../../shared/ipc'
import type { BoardSyncInput, PersistenceRepository } from '../persistence/types'
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
