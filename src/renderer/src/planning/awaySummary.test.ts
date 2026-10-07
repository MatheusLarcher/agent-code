import { describe, expect, it } from 'vitest'
import { BOARD_TURN_END_REASON, type BoardItem } from '@shared/ipc'
import { HANDOFF_REMOVED_MOTIVO, type HandoffEnvio } from '@shared/handoffTracking'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { item } from '../office3d/board/boardTestKit'
import { AWAY_MIN_MS, awayDuration, awayHeadline, awaySpeech, buildAwaySummary } from './awaySummary'

/**
 * O resumo "desde que você saiu": regra fixa sobre o banco. Mais de 30 min fora
 * com mudanças → resumo; sem mudanças → nada; menos de 30 min → nada.
 */

const SINCE = Date.UTC(2026, 9, 6, 10, 0)
const MIN = 60_000
const iso = (ms: number): string => new Date(ms).toISOString()
const after = iso(SINCE + 20 * MIN)
const before = iso(SINCE - 20 * MIN)

function build(items: BoardItem[], envios: HandoffEnvio[] = [], now = SINCE + 2 * 60 * MIN) {
  return buildAwaySummary({ projectKey: 'c:/proj', projectCwd: 'C:/proj', items, envios, since: SINCE, now })
}

const awaiting = (id: string, updatedAt: string): BoardItem =>
  item(id, { poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result, updatedAt })

describe('buildAwaySummary', () => {
  it('mais de 30 min fora com mudanças: concluídas, espera você e falhou, na faixa e no balão', () => {
    const summary = build(
      [
        item('c1', { sourceStatus: 'completed', updatedAt: after }),
        item('c2', { sourceStatus: 'completed', updatedAt: iso(SINCE + 90 * MIN) }),
        item('velho', { sourceStatus: 'completed', updatedAt: before }),
        awaiting('p1', after),
        item('parado', { updatedAt: after })
      ],
      [envio({ id: 'e1', status: 'falhou', motivo: 'o agente caiu', updatedAt: after, entregas: [entrega({ boardItemId: 'card-e1' })] })]
    )
    expect(summary?.counts).toEqual({ concluida: 2, espera: 1, falhou: 1 })
    expect(awayHeadline(summary!)).toBe('Desde que você saiu (há 2 h): 2 concluídas · 1 espera você · 1 falhou')
    expect(awaySpeech(summary!)).toBe('Desde que você saiu: 2 concluídas, 1 espera você e 1 falhou.')
    // A lista: concluídas (a mais recente primeiro), espera, falhou — com o cartão que o clique abre.
    expect(summary?.entries.map((e) => [e.kind, e.cardId])).toEqual([
      ['concluida', 'c2'],
      ['concluida', 'c1'],
      ['espera', 'p1'],
      ['falhou', 'card-e1']
    ])
    expect(summary?.entries[3]).toMatchObject({ title: 'Prompt 1 de 1 — Checkout com Pix', detail: 'o agente caiu', conversationId: 'conv-1' })
  })

  it('sem mudanças depois da última visita: nada', () => {
    const summary = build(
      [item('c1', { sourceStatus: 'completed', updatedAt: before }), awaiting('p1', before)],
      [envio({ status: 'falhou', updatedAt: before })]
    )
    expect(summary).toBeNull()
  })

  it('menos de 30 min fora: nada, mesmo com mudança; 30 min em ponto já conta', () => {
    const items = [item('c1', { sourceStatus: 'completed', updatedAt: iso(SINCE + MIN) })]
    expect(build(items, [], SINCE + AWAY_MIN_MS - 1)).toBeNull()
    expect(build(items, [], SINCE + AWAY_MIN_MS)?.counts.concluida).toBe(1)
  })

  it('o que você tirou da fila não é falha; a fila parada atrás de um incompleto é', () => {
    const removed = envio({ id: 'r', status: 'parada', enviadoEm: null, motivo: HANDOFF_REMOVED_MOTIVO, updatedAt: after })
    const stalled = envio({ id: 'i', status: 'incompleta', updatedAt: after, conversationId: 'conv-2', loteId: 'hl-2' })
    const waiting = envio({ id: 'w', status: 'na_fila', ordem: 2, updatedAt: before, conversationId: 'conv-2', loteId: 'hl-2' })
    const lone = envio({ id: 'l', status: 'incompleta', updatedAt: after, conversationId: 'conv-3', loteId: 'hl-3' })
    const summary = build([], [removed, stalled, waiting, lone])
    expect(summary?.counts).toEqual({ concluida: 0, espera: 0, falhou: 1 })
    expect(summary?.entries[0]).toMatchObject({ cardId: null, conversationId: 'conv-2', detail: 'a fila parou — 1 prompt espera no quadro' })
    expect(awayHeadline(summary!)).toBe('Desde que você saiu (há 2 h): 1 falhou')
  })

  it('cartão arquivado não conta; "Interrompido" espera você também', () => {
    const summary = build([
      item('arquivado', { sourceStatus: 'completed', updatedAt: after, dismissedAt: after }),
      item('int', { poStatus: 'pending', poReason: BOARD_TURN_END_REASON.error, updatedAt: after })
    ])
    expect(summary?.counts).toEqual({ concluida: 0, espera: 1, falhou: 0 })
    expect(summary?.entries[0].detail).toBe('Interrompido')
  })

  it('awayDuration: minutos, horas e dias', () => {
    expect(awayDuration(45 * MIN)).toBe('45 min')
    expect(awayDuration(110 * MIN)).toBe('2 h')
    expect(awayDuration(26 * 60 * MIN)).toBe('1 dia')
    expect(awayDuration(3 * 24 * 60 * MIN)).toBe('3 dias')
  })
})
