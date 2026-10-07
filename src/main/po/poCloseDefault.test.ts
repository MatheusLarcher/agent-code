// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BOARD_TURN_END_REASON, boardTurnEndReason, type BoardItem } from '../../shared/ipc'
import { RESUME_REASON } from '../board/boardService'
import type { BoardPoWrite } from '../persistence/types'
import { applyPoVerdict, type PoApplyDeps } from './poApply'
import {
  defaultCompletions,
  isReadablePoVerdict,
  PO_DEFAULT_COMPLETE_REASON,
  poReturnedCards,
  untouchedSinceTurnEnd
} from './poCloseDefault'
import { buildPoDigest, PO_RESUMED_MARK, PO_RETURNED_SECTION } from './poPrompt'

function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'p',
    projectCwd: 'C:/p',
    conversationId: 'c',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: 'Implementar a fase 1',
    sourceStatus: 'in_progress',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 3,
    createdAt: '',
    updatedAt: '',
    ...over
  }
}

const demoted = (over: Partial<BoardItem> = {}): BoardItem =>
  card({ poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result, ...over })

describe('poReturnedCards — o que o fechamento julga', () => {
  it('os "em andamento" entram; concluído, "a fazer" comum e dispensado não', () => {
    const cards = [
      card({ id: 'andando' }),
      card({ id: 'feito', sourceStatus: 'completed' }),
      card({ id: 'a-fazer', sourceStatus: 'pending' }),
      card({ id: 'dispensado', dismissedAt: '2026-10-06T00:00:00Z' })
    ]
    expect(poReturnedCards({ cards, background: false }).map((c) => c.id)).toEqual(['andando'])
  })

  it('com segundo plano rodando ou turno novo rodando (rodada da fila), nada é julgado', () => {
    const cards = [card()]
    expect(poReturnedCards({ cards, background: true })).toEqual([])
    expect(poReturnedCards({ cards, background: false, turnRunning: true })).toEqual([])
  })

  it('o rebaixado pelo ÚLTIMO fim de turno normal entra (rodada da fila do cooldown); justificado e interrompido não', () => {
    const cards = [
      demoted({ id: 'rebaixado' }),
      demoted({ id: 'de-outro-turno' }),
      demoted({ id: 'justificado', poReason: boardTurnEndReason('result', 'falta commitar') }),
      demoted({ id: 'interrompido', poReason: BOARD_TURN_END_REASON.error })
    ]
    const demotedAtTurnEnd = new Set(['rebaixado', 'justificado', 'interrompido'])
    expect(poReturnedCards({ cards, background: false, demotedAtTurnEnd }).map((c) => c.id)).toEqual(['rebaixado'])
    expect(poReturnedCards({ cards, background: false, demotedAtTurnEnd: null })).toEqual([])
  })

  it('o retomado pela mensagem fica de fora quando a abertura criou o cartão do pedido (assunto novo)', () => {
    const resumed = card({ id: 'retomado', poStatus: 'in_progress', poReason: RESUME_REASON })
    const opened = card({ id: 'bi-po-novo', origin: 'po', sourceId: null, poReason: 'pedido do usuário' })
    expect(poReturnedCards({ cards: [resumed], background: false }).map((c) => c.id)).toEqual(['retomado'])
    expect(poReturnedCards({ cards: [resumed, opened], background: false }).map((c) => c.id)).toEqual(['bi-po-novo'])
  })

  it('o digest lista os julgados, com a marca no retomado', () => {
    const digest = buildPoDigest({
      phase: 'close',
      userText: 'continua',
      cards: [{ id: 'bi-a', title: 'A', status: 'in_progress' }],
      calls: [],
      returned: ['bi-a', 'bi-b'],
      resumed: ['bi-b']
    })
    expect(digest).toContain(`${PO_RETURNED_SECTION}\n- bi-a\n- bi-b ${PO_RESUMED_MARK}`)
  })
})

describe('defaultCompletions — sem PENDENTE, concluído', () => {
  const returned = [card({ id: 'bi-a' }), card({ id: 'bi-b' }), card({ id: 'bi-c' })]

  it('OK conclui todos; CONCLUIR e PENDENTE (mesmo sem motivo) tiram o cartão do padrão', () => {
    expect(defaultCompletions('OK', returned).map((c) => c.id)).toEqual(['bi-a', 'bi-b', 'bi-c'])
    const verdict = 'CONCLUIR bi-a | entregue\nPENDENTE bi-b |\nTITULO bi-c | Novo | legível'
    expect(defaultCompletions(verdict, returned).map((c) => c.id)).toEqual(['bi-c'])
  })

  it('resposta fora do formato não é veredito: nada conclui pelo padrão', () => {
    expect(isReadablePoVerdict('Não há nada a corrigir neste turno.')).toBe(false)
    expect(isReadablePoVerdict('')).toBe(false)
    expect(isReadablePoVerdict('- `OK`')).toBe(true)
    expect(defaultCompletions('Tudo certo por aqui.', returned)).toEqual([])
  })
})

describe('untouchedSinceTurnEnd — a guarda da escrita', () => {
  const listed = card({ revision: 3 })
  const guard = untouchedSinceTurnEnd(listed)

  it('vale para o intocado e para o rebaixado pelo fim de turno normal sem PENDENTE', () => {
    expect(guard(card({ revision: 3 }))).toBe(true)
    expect(guard(demoted({ revision: 4 }))).toBe(true)
  })

  it('não vale para o retomado, o justificado, o interrompido, o arrastado e o dispensado', () => {
    expect(guard(card({ revision: 5, poStatus: 'in_progress', poReason: RESUME_REASON }))).toBe(false)
    expect(guard(demoted({ revision: 5, poReason: boardTurnEndReason('result', 'falta X') }))).toBe(false)
    expect(guard(demoted({ revision: 5, poReason: BOARD_TURN_END_REASON.error }))).toBe(false)
    expect(guard(card({ revision: 4, poStatus: 'pending', poReason: 'o usuário moveu o cartão' }))).toBe(false)
    expect(guard(card({ revision: 3, dismissedAt: '2026-10-06T00:00:00Z' }))).toBe(false)
  })
})

describe('applyPoVerdict — o padrão na escrita', () => {
  function deps(cards: BoardItem[]) {
    const writes: BoardPoWrite[] = []
    const board = {
      list: vi.fn(async () => cards),
      applyPo: vi.fn(async (input: BoardPoWrite) => {
        writes.push(input)
        const current = cards.find((c) => c.id === input.id)!
        if (input.onlyIf && !input.onlyIf(current)) return current
        return { ...current, poStatus: input.poStatus ?? current.poStatus, poReason: input.poReason ?? current.poReason }
      }),
      createPoItem: vi.fn(async () => null)
    }
    const d: PoApplyDeps = { board, listConvTasks: async () => [], linkableLedgerTasks: async () => [] }
    return { d, writes }
  }
  const target = (returned: BoardItem[]) => ({ convId: 'c', cwd: 'C:/p', projectId: 'p', phase: 'close' as const, startedAt: 0, returned })

  it('OK + TITULO: conclui primeiro (com a guarda) e só depois renomeia', async () => {
    const a = card({ id: 'bi-a' })
    const { d, writes } = deps([a])
    const progress = { applied: 0, touched: [] as string[] }
    await applyPoVerdict(d, target([a]), 'TITULO bi-a | Fase 1 do escritório | o título era técnico', [a], progress)
    expect(writes.map((w) => [w.id, w.poStatus ?? null, w.poTitle ?? null])).toEqual([
      ['bi-a', 'completed', null],
      ['bi-a', null, 'Fase 1 do escritório']
    ])
    expect(writes[0]).toMatchObject({ poReason: PO_DEFAULT_COMPLETE_REASON, onlyIf: expect.any(Function) })
    expect(progress.applied).toBe(2)
  })

  it('PENDENTE segura o cartão; a guarda que falha não conta como escrita', async () => {
    const a = card({ id: 'bi-a' })
    const b = card({ id: 'bi-b', revision: 9 })
    const listedB = card({ id: 'bi-b', revision: 3 })
    const { d, writes } = deps([a, b])
    const progress = { applied: 0, touched: [] as string[] }
    await applyPoVerdict(d, target([a, listedB]), 'PENDENTE bi-a | parou no meio: falta o teste de integração', [a, listedB], progress)
    expect(writes.find((w) => w.id === 'bi-a' && w.poStatus === 'completed')).toBeUndefined()
    // bi-b mudou depois da leitura (revisão 9): a guarda recusou, nada foi aplicado nele.
    expect(progress.touched).toEqual(['bi-a'])
  })

  it('na abertura não há padrão nenhum', async () => {
    const a = card({ id: 'bi-a' })
    const { d, writes } = deps([a])
    await applyPoVerdict(d, { ...target([a]), phase: 'open' }, 'OK', [a], { applied: 0, touched: [] })
    expect(writes).toEqual([])
  })
})
