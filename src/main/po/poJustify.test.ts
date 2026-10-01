// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { BOARD_TURN_END_REASON, type BoardItem } from '../../shared/ipc'
import type { BoardPoWrite } from '../persistence/types'
import { applyPoVerdict, type PoApplyDeps, type PoApplyTarget } from './poApply'
import {
  buildPoDigest,
  PO_MAX_DIGEST_CHARS,
  PO_RETURNED_SECTION,
  PO_SYSTEM_PROMPT_CLOSE
} from './poPrompt'
import { parsePoVerdict, rejectUnsafeOps } from './poVerdict'

/**
 * O PO justifica toda alteração: TITULO exige motivo, e o PENDENTE diz o que
 * faltou no cartão que o fim do turno devolve para "a fazer" — sem mudar o
 * status, só trocando a frase genérica pelo motivo concreto.
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

const target: PoApplyTarget = { convId: 'conv-1', cwd: 'C:/p', projectId: 'p', phase: 'close', startedAt: 0 }
const ids = ['bi-1', 'bi-2']

describe('parser — TITULO com motivo e PENDENTE', () => {
  it('TITULO com motivo vira retitle com o motivo', () => {
    expect(parsePoVerdict('TITULO bi-1 | Criar o quadro | o título era técnico demais', ids)).toEqual([
      { kind: 'retitle', id: 'bi-1', title: 'Criar o quadro', reason: 'o título era técnico demais' }
    ])
  })

  it('TITULO sem motivo é descartado, como as outras operações sem motivo', () => {
    expect(parsePoVerdict('TITULO bi-1 | Criar o quadro', ids)).toEqual([])
    expect(parsePoVerdict('TITULO bi-1 | Criar o quadro |   ', ids)).toEqual([])
  })

  it('PENDENTE lê o motivo concreto, só no fechamento e só com id conhecido', () => {
    const raw = 'PENDENTE bi-2 | falta verificar no app rodando e commitar'
    expect(parsePoVerdict(raw, ids, 'close')).toEqual([
      { kind: 'justify', id: 'bi-2', reason: 'falta verificar no app rodando e commitar' }
    ])
    expect(parsePoVerdict(raw, ids, 'open')).toEqual([])
    expect(parsePoVerdict('PENDENTE bi-9 | falta tudo', ids)).toEqual([])
    expect(parsePoVerdict('PENDENTE bi-2 |   ', ids)).toEqual([])
  })
})

describe('rejectUnsafeOps — PENDENTE', () => {
  it('passa no cartão em andamento e no já devolvido pelo fim do turno; não no concluído nem no "a fazer" comum', () => {
    const cards = [
      card('bi-andando', 'in_progress'),
      card('bi-devolvido', 'in_progress', { poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result }),
      card('bi-feito', 'completed'),
      card('bi-novo', 'pending')
    ]
    const ops = cards.map((c) => ({ kind: 'justify' as const, id: c.id, reason: 'falta X' }))
    expect(rejectUnsafeOps(ops, cards).map((op) => ('id' in op ? op.id : ''))).toEqual(['bi-andando', 'bi-devolvido'])
  })

  it('CONCLUIR na mesma resposta vence o PENDENTE', () => {
    const cards = [card('bi-1', 'in_progress')]
    const out = rejectUnsafeOps(
      [
        { kind: 'justify', id: 'bi-1', reason: 'falta X' },
        { kind: 'complete', id: 'bi-1', reason: 'entregue' }
      ],
      cards
    )
    expect(out).toEqual([{ kind: 'complete', id: 'bi-1', reason: 'entregue' }])
  })
})

describe('applyPoVerdict — o motivo é gravado', () => {
  it('PENDENTE grava o motivo (frase do fim de turno + o que faltou) e NÃO muda o status', async () => {
    const cards = [card('bi-1', 'in_progress')]
    const d = deps(cards)
    const progress = { applied: 0, touched: [] as string[] }
    await applyPoVerdict(d, target, 'PENDENTE bi-1 | falta verificar no app rodando e commitar', cards, progress)

    expect(d.board.applyPo).toHaveBeenCalledTimes(1)
    const write = d.board.applyPo.mock.calls[0][0]
    expect(write).toEqual({
      id: 'bi-1',
      poReason: `${BOARD_TURN_END_REASON.result} — falta verificar no app rodando e commitar`,
      eventNote: 'falta verificar no app rodando e commitar'
    })
    expect(write.poStatus).toBeUndefined()
    expect(progress).toEqual({ applied: 1, touched: ['bi-1'] })
  })

  it('PENDENTE no cartão já interrompido mantém a frase da interrupção', async () => {
    const cards = [card('bi-1', 'in_progress', { poStatus: 'pending', poReason: BOARD_TURN_END_REASON.error })]
    const d = deps(cards)
    await applyPoVerdict(d, target, 'PENDENTE bi-1 | o build quebrou no meio', cards, { applied: 0, touched: [] })
    expect(d.board.applyPo.mock.calls[0][0].poReason).toBe(`${BOARD_TURN_END_REASON.error} — o build quebrou no meio`)
  })

  it('TITULO grava o motivo em po_reason', async () => {
    const cards = [card('bi-1', 'completed')]
    const d = deps(cards)
    await applyPoVerdict(d, target, 'TITULO bi-1 | Criar o quadro | o título era técnico', cards, {
      applied: 0,
      touched: []
    })
    expect(d.board.applyPo).toHaveBeenCalledWith({ id: 'bi-1', poTitle: 'Criar o quadro', poReason: 'o título era técnico' })
  })

  it('TITULO não apaga o motivo do fim de turno: o motivo vai só para a linha do tempo', async () => {
    const cards = [card('bi-1', 'in_progress', { poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })]
    const d = deps(cards)
    await applyPoVerdict(d, target, 'TITULO bi-1 | Criar o quadro | o título era técnico', cards, {
      applied: 0,
      touched: []
    })
    expect(d.board.applyPo).toHaveBeenCalledWith({ id: 'bi-1', poTitle: 'Criar o quadro', eventNote: 'o título era técnico' })
  })
})

describe('digest e prompt de fechamento', () => {
  const cards = [
    { id: 'bi-andando', title: 'Implementar a fase 1', status: 'in_progress' as const },
    { id: 'bi-feito', title: 'Outra', status: 'completed' as const }
  ]

  it('lista os cartões que o fim do turno devolve para "a fazer"', () => {
    const digest = buildPoDigest({ phase: 'close', userText: 'faça', cards, calls: [] })
    expect(digest).toContain(`${PO_RETURNED_SECTION}\n- bi-andando`)
    expect(digest).not.toContain('- bi-feito')
  })

  it('sem a seção quando há trabalho em segundo plano (o fechamento não devolve nada) e na abertura', () => {
    expect(buildPoDigest({ phase: 'close', userText: 'x', cards, calls: [], background: ['subagente'] })).not.toContain(
      PO_RETURNED_SECTION
    )
    expect(buildPoDigest({ phase: 'open', userText: 'x', cards, calls: [] })).not.toContain(PO_RETURNED_SECTION)
  })

  it('o pior caso com a seção (sem segundo plano) continua dentro do teto documentado', () => {
    const digest = buildPoDigest({
      phase: 'close',
      userText: 'p'.repeat(5_000),
      cards: Array.from({ length: 40 }, (_, i) => ({
        id: `bi-${String(i).padStart(80, '0')}`,
        title: 't'.repeat(300),
        status: 'in_progress' as const
      })),
      calls: Array.from({ length: 100 }, () => ({ tool: 'mcp__servidor__ferramenta', detail: 'd'.repeat(500) })),
      agentReply: 'r'.repeat(5_000),
      ledgerTasks: Array.from({ length: 30 }, () => ({ title: 'x'.repeat(300), status: 's'.repeat(40) }))
    })
    expect(digest).toContain(PO_RETURNED_SECTION)
    expect(digest.length).toBeLessThanOrEqual(PO_MAX_DIGEST_CHARS)
  })

  it('o prompt exige motivo em TITULO e PENDENTE (ou CONCLUIR) para todo cartão devolvido', () => {
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('TITULO <id> | <novo título> | <motivo curto>')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('PENDENTE <id> | <o que faltou>')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain(`Se houver a seção "${PO_RETURNED_SECTION}"`)
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('PENDENTE NÃO muda o status')
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('falta verificar no app rodando e commitar')
    // A regra c) de entregue com pendências continua valendo.
    expect(PO_SYSTEM_PROMPT_CLOSE).toContain('O pedido foi ENTREGUE no essencial')
  })
})
