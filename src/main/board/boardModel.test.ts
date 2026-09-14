// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BoardItem } from '../persistence/types'
import {
  boardItemStatus as effectiveStatus,
  boardItemTitle as effectiveTitle,
  isBoardItemPoCorrected as isPoCorrected
} from '../../shared/ipc'
import {
  assertPoCreate,
  assertPoWrite,
  boardItemId,
  compareBoardItems,
  normalizeSourceItems
} from './boardModel'

function item(patch: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'p1',
    projectCwd: 'C:/x',
    conversationId: 'c1',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'título do agente',
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
    createdAt: '2026-09-14T12:00:00.000Z',
    updatedAt: '2026-09-14T12:00:00.000Z',
    ...patch
  }
}

describe('boardItemId', () => {
  it('é determinístico — a mesma tarefa relida do snapshot não vira um segundo cartão', () => {
    expect(boardItemId('c1', '2')).toBe(boardItemId('c1', '2'))
  })

  it('separa a mesma numeração em conversas diferentes', () => {
    expect(boardItemId('c1', '1')).not.toBe(boardItemId('c2', '1'))
  })
})

describe('sobreposição das duas camadas', () => {
  it('sem PO, o que vale é o que o agente declarou', () => {
    const card = item()
    expect(effectiveTitle(card)).toBe('título do agente')
    expect(effectiveStatus(card)).toBe('pending')
    expect(isPoCorrected(card)).toBe(false)
  })

  it('o PO sobrepõe título e status sem apagar o original', () => {
    const card = item({ poTitle: 'Título legível', poStatus: 'completed', poReason: 'o agente esqueceu' })
    expect(effectiveTitle(card)).toBe('Título legível')
    expect(effectiveStatus(card)).toBe('completed')
    expect(card.sourceTitle).toBe('título do agente')
    expect(card.sourceStatus).toBe('pending')
    expect(isPoCorrected(card)).toBe(true)
  })

  it('PO concordando com o agente não conta como correção', () => {
    const card = item({ sourceStatus: 'completed', poStatus: 'completed', poReason: 'confirmado' })
    expect(isPoCorrected(card)).toBe(false)
  })
})

describe('compareBoardItems', () => {
  it('ordena em andamento, pendente e concluído — e usa o status EFETIVO', () => {
    const ordered = [
      item({ id: 'a', sourceStatus: 'completed', seq: 0 }),
      item({ id: 'b', sourceStatus: 'pending', seq: 1 }),
      item({ id: 'c', sourceStatus: 'pending', poStatus: 'in_progress', poReason: 'começou', seq: 2 })
    ].sort(compareBoardItems)
    expect(ordered.map((entry) => entry.id)).toEqual(['c', 'b', 'a'])
  })

  it('dentro do mesmo status mantém a ordem numerada pelo CLI', () => {
    const ordered = [item({ id: 'b', seq: 10 }), item({ id: 'a', seq: 2 })].sort(compareBoardItems)
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('normalizeSourceItems', () => {
  it('descarta item sem id e duplicado, preservando o primeiro', () => {
    const items = normalizeSourceItems([
      { sourceId: '1', title: 'um', status: 'pending', activeForm: null, seq: 0 },
      { sourceId: '  ', title: 'sem id', status: 'pending', activeForm: null, seq: 1 },
      { sourceId: '1', title: 'repetido', status: 'completed', activeForm: null, seq: 2 }
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ sourceId: '1', title: 'um' })
  })

  it('status desconhecido cai em pending em vez de derrubar a ingestão', () => {
    const items = normalizeSourceItems([
      { sourceId: '1', title: 'x', status: 'wat' as never, activeForm: null, seq: 0 }
    ])
    expect(items[0].status).toBe('pending')
  })
})

describe('validação da escrita do PO', () => {
  it('mudar status sem motivo é recusado — correção sem rastro não dá para auditar', () => {
    expect(() => assertPoWrite({ id: 'bi-1', poStatus: 'completed' })).toThrow(/motivo/i)
  })

  it('mudar só o título não exige motivo', () => {
    expect(() => assertPoWrite({ id: 'bi-1', poTitle: 'melhor título' })).not.toThrow()
  })

  it('limpar o status (null) é permitido sem motivo — é desfazer, não corrigir', () => {
    expect(() => assertPoWrite({ id: 'bi-1', poStatus: null })).not.toThrow()
  })

  it('status inválido é recusado', () => {
    expect(() => assertPoWrite({ id: 'bi-1', poStatus: 'done' as never, poReason: 'x' })).toThrow(/inválido/i)
  })

  it('cartão criado pelo PO exige título e motivo', () => {
    const base = { projectId: 'p', projectCwd: 'C:/x', conversationId: 'c', status: 'pending' as const }
    expect(() => assertPoCreate({ ...base, title: '', reason: 'surgiu no meio' })).toThrow(/título/i)
    expect(() => assertPoCreate({ ...base, title: 'nova', reason: '' })).toThrow(/motivo/i)
    expect(() => assertPoCreate({ ...base, title: 'nova', reason: 'surgiu no meio' })).not.toThrow()
  })
})
