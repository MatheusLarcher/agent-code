// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { BoardItem, BoardSourceItem } from '../persistence/types'
import {
  boardItemStatus as effectiveStatus,
  boardItemTitle as effectiveTitle,
  isBoardItemPoCorrected as isPoCorrected
} from '../../shared/ipc'
import {
  assertPoCreate,
  assertPoWrite,
  boardItemId,
  boardItemsToReopen,
  boardItemsToReopenBefore,
  compareBoardItems,
  normalizeSourceItems,
  planBoardSourceSync,
  type BoardSyncCurrent
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

describe('boardItemsToReopen', () => {
  it('devolve só o que ficou em andamento', () => {
    const stale = boardItemsToReopen([
      item({ id: 'a', sourceStatus: 'in_progress' }),
      item({ id: 'b', sourceStatus: 'pending' }),
      item({ id: 'c', sourceStatus: 'completed' })
    ])
    expect(stale.map((entry) => entry.id)).toEqual(['a'])
  })

  it('cartão que o PO concluiu NÃO é reaberto — o status efetivo é que manda', () => {
    const stale = boardItemsToReopen([
      item({ sourceStatus: 'in_progress', poStatus: 'completed', poReason: 'o agente esqueceu de marcar' })
    ])
    expect(stale).toEqual([])
  })

  it('cartão já reaberto não volta a ser reaberto — a correção é idempotente', () => {
    const stale = boardItemsToReopen([
      item({ sourceStatus: 'in_progress', poStatus: 'pending', poReason: 'o turno terminou sem concluir esta tarefa' })
    ])
    expect(stale).toEqual([])
  })

  it('cartão arquivado fica onde está', () => {
    const stale = boardItemsToReopen([
      item({ sourceStatus: 'in_progress', dismissedAt: '2026-09-14T12:00:00.000Z' })
    ])
    expect(stale).toEqual([])
  })
})

describe('boardItemsToReopenBefore — a race entre a reabertura e a abertura seguinte', () => {
  const closedAt = Date.parse('2026-09-17T01:00:00.000Z')

  it('cartão tocado pelo PO DEPOIS do fim do turno não é reaberto — ele já foi promovido de novo', () => {
    const stale = boardItemsToReopenBefore(
      [
        item({
          sourceStatus: 'in_progress',
          poStatus: 'in_progress',
          poReason: 'a mensagem seguinte retomou o trabalho',
          poAt: '2026-09-17T01:00:05.000Z' // depois do corte
        })
      ],
      closedAt
    )
    expect(stale).toEqual([])
  })

  it('cartão sem toque do PO depois do corte continua sendo reaberto normalmente', () => {
    const stale = boardItemsToReopenBefore(
      [item({ id: 'a', sourceStatus: 'in_progress', poAt: '2026-09-17T00:59:00.000Z' })],
      closedAt
    )
    expect(stale.map((entry) => entry.id)).toEqual(['a'])
  })

  it('cartão sem poAt nenhum (nunca tocado pelo PO) é reaberto — sem carimbo, não há como provar recência', () => {
    const stale = boardItemsToReopenBefore([item({ id: 'a', sourceStatus: 'in_progress', poAt: null })], closedAt)
    expect(stale.map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('planBoardSourceSync', () => {
  function current(patch: Partial<BoardSyncCurrent> = {}): BoardSyncCurrent {
    return {
      project_id: 'p1',
      source_title: 'uma',
      source_status: 'in_progress',
      active_form: null,
      seq: 0,
      po_status: null,
      ...patch
    }
  }

  const incoming = (patch: Partial<BoardSourceItem> = {}): BoardSourceItem => ({
    sourceId: '1',
    title: 'uma',
    status: 'in_progress',
    activeForm: null,
    seq: 0,
    ...patch
  })

  it('o mesmo snapshot de novo não é escrita nenhuma', () => {
    expect(planBoardSourceSync(current(), incoming(), 'p1')).toEqual({ unchanged: true, clearPoStatus: false })
  })

  it('status novo do agente solta a correção de status do PO', () => {
    const plan = planBoardSourceSync(current({ po_status: 'pending' }), incoming({ status: 'completed' }), 'p1')
    expect(plan).toEqual({ unchanged: false, clearPoStatus: true })
  })

  it('o MESMO status de novo preserva a correção do PO — é aqui que uma ingestão descuidada a apagaria', () => {
    const plan = planBoardSourceSync(current({ po_status: 'completed' }), incoming(), 'p1')
    expect(plan).toEqual({ unchanged: true, clearPoStatus: false })
  })

  it('cartão reaberto que o agente volta a declarar em andamento solta a reabertura', () => {
    // O `source_status` nem muda: o cartão reaberto continua `in_progress` na
    // lista do CLI. Sem esta metade da regra ele ficaria travado em "a fazer"
    // com o agente trabalhando nele.
    const plan = planBoardSourceSync(current({ po_status: 'pending' }), incoming(), 'p1')
    expect(plan).toEqual({ unchanged: false, clearPoStatus: true })
  })

  it('o "concluído" do PO não cai com o snapshot em andamento reemitido', () => {
    const plan = planBoardSourceSync(current({ po_status: 'completed' }), incoming(), 'p1')
    expect(plan).toEqual({ unchanged: true, clearPoStatus: false })
  })

  it('mudar só o título não mexe no PO: título legível não é estado', () => {
    const plan = planBoardSourceSync(current({ po_status: 'completed' }), incoming({ title: 'uma, agora melhor' }), 'p1')
    expect(plan).toEqual({ unchanged: false, clearPoStatus: false })
  })

  it('mudar só activeForm ou seq também não mexe no PO', () => {
    const base = current({ po_status: 'completed' })
    expect(planBoardSourceSync(base, incoming({ activeForm: 'Fazendo uma' }), 'p1').clearPoStatus).toBe(false)
    expect(planBoardSourceSync(base, incoming({ seq: 3 }), 'p1').clearPoStatus).toBe(false)
  })

  it('status novo sem correção do PO não pede limpeza à toa', () => {
    const plan = planBoardSourceSync(current(), incoming({ status: 'completed' }), 'p1')
    expect(plan).toEqual({ unchanged: false, clearPoStatus: false })
  })

  it('projeto que mudou de identidade é escrita, não silêncio', () => {
    expect(planBoardSourceSync(current(), incoming(), 'p2').unchanged).toBe(false)
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
