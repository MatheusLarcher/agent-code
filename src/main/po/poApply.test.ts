// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { BoardItem } from '../../shared/ipc'
import type { BoardPoWrite } from '../persistence/types'
import { applyPoVerdict, confirmCreates, type PoApplyDeps, type PoApplyTarget } from './poApply'
import type { PoOp } from './poVerdict'

/**
 * O que é contrato PRÓPRIO do módulo extraído. A aplicação de cada operação
 * (CONCLUIR, ANDAMENTO, TITULO, NOVA/FEITA e o vínculo tarefa↔cartão) já é
 * coberta ponta a ponta em po.test.ts; aqui fica quando a lista fresca é lida,
 * o que ela barra, e o progresso que sobrevive a uma escrita que lança.
 */

function card(id: string, sourceStatus: BoardItem['sourceStatus'], over: Partial<BoardItem> = {}): BoardItem {
  return {
    id,
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: id,
    sourceTitle: `tarefa ${id}`,
    sourceStatus,
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

function deps(fresh: BoardItem[] | null) {
  const board = {
    list: vi.fn(async () => fresh),
    applyPo: vi.fn(async (_input: BoardPoWrite): Promise<BoardItem | null> => null),
    createPoItem: vi.fn(async () => null)
  }
  return { board, linkableLedgerTasks: async () => [] } as PoApplyDeps & { board: typeof board }
}

const target = (phase: PoApplyTarget['phase']): PoApplyTarget => ({
  convId: 'conv-1',
  cwd: 'C:/p',
  projectId: 'p',
  phase,
  startedAt: 0
})

describe('confirmCreates — a lista fresca antes de escrever', () => {
  it('CONCLUIR e TITULO sozinhos não pagam a releitura: seguem como vieram', async () => {
    const d = deps([card('bi-1', 'completed')])
    const ops: PoOp[] = [
      { kind: 'complete', id: 'bi-1', reason: 'o teste passou' },
      { kind: 'retitle', id: 'bi-1', title: 'Novo nome', reason: 'legível' }
    ]

    expect(await confirmCreates(d, ops, target('close'))).toBe(ops)
    expect(d.board.list).not.toHaveBeenCalled()
  })

  it('ANDAMENTO relê o quadro e só passa no cartão que CONTINUA "a fazer"', async () => {
    const d = deps([
      card('bi-feito', 'pending', { poStatus: 'completed' }),
      card('bi-andando', 'in_progress'),
      card('bi-parado', 'pending')
    ])
    const ops: PoOp[] = ['bi-feito', 'bi-andando', 'bi-parado'].map((id) => ({ kind: 'start', id, reason: 'retomando' }))

    expect(await confirmCreates(d, ops, target('open'))).toEqual([{ kind: 'start', id: 'bi-parado', reason: 'retomando' }])
    expect(d.board.list).toHaveBeenCalledTimes(1)
    expect(d.board.list).toHaveBeenCalledWith('C:/p', { conversationId: 'conv-1' })
  })

  it('sem lista fresca, criar e pôr em andamento caem (falha fechada); CONCLUIR e TITULO seguem', async () => {
    const d = deps(null)
    const complete: PoOp = { kind: 'complete', id: 'bi-1', reason: 'o teste passou' }
    const retitle: PoOp = { kind: 'retitle', id: 'bi-1', title: 'Novo nome', reason: 'legível' }
    const ops: PoOp[] = [
      complete,
      { kind: 'start', id: 'bi-2', reason: 'retomando' },
      retitle,
      { kind: 'create', title: 'Tarefa nova', reason: 'pedido agora', status: 'in_progress' }
    ]

    expect(await confirmCreates(d, ops, target('open'))).toEqual([complete, retitle])
  })
})

describe('applyPoVerdict — o progresso é de quem chamou', () => {
  it('uma escrita que lança no meio propaga, e o que já foi escrito continua contado', async () => {
    const d = deps(null)
    d.board.applyPo.mockImplementation(async (input) => {
      if (input.id === 'bi-2') throw new Error('banco fora do ar')
      return null
    })
    const cards = [card('bi-1', 'in_progress'), card('bi-2', 'in_progress')]
    const progress = { applied: 0, touched: [] as string[] }

    await expect(
      applyPoVerdict(d, target('close'), 'CONCLUIR bi-1 | o teste passou\nCONCLUIR bi-2 | o build passou', cards, progress)
    ).rejects.toThrow('banco fora do ar')
    expect(progress).toEqual({ applied: 1, touched: ['bi-1'] })
  })
})
