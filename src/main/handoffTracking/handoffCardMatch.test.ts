// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  CARD_EPOCH_SLACK_MS,
  CARD_ETAPA_PREFIX,
  cardForEtapa,
  describeMissing,
  entregasWithCardInProgress,
  syncEntregas,
  turnEndOutcome
} from './handoffRules'
import { card, entrega, envio, iso, T0 } from './handoffTestKit'

// O casamento cartão ↔ etapa (handoffCardMatch.ts): o desempate sem cartão
// concluído e a trava de época (marco: o registro do lote, `criadoEm`, menos a
// folga). O resto do casamento está em handoffRules.test.ts.

const NOW = iso(T0 + 60_000)
const ctx = { now: NOW, poEnabled: true }

describe('desempate sem cartão concluído', () => {
  it('o EM ANDAMENTO vence: em andamento > ligado > mesma conversa > mais novo', () => {
    const cards = [
      card({ id: 'ligado', conversationId: 'conv-1', updatedAt: iso(T0 + 9_000) }),
      card({ id: 'andando', sourceStatus: 'in_progress', conversationId: 'outra', updatedAt: iso(T0) }),
      card({ id: 'contestado', sourceStatus: 'completed', poStatus: 'in_progress', poReason: 'sem teste', updatedAt: iso(T0 + 9_000) })
    ]
    expect(cardForEtapa(cards, 'etapa-a', { boardItemId: 'ligado', conversationId: 'conv-1' })?.id).toBe('andando')
    // O em andamento CONTESTADO não passa à frente do ligado.
    expect(cardForEtapa([cards[0], cards[2]], 'etapa-a', { boardItemId: 'ligado' })?.id).toBe('ligado')
  })

  it('cartão velho ligado "a fazer" + cartão novo da lista nova "em andamento": a entrega fica em andamento', () => {
    const e = envio({ entregas: [entrega({ boardItemId: 'velho' })] })
    const cards = [
      card({ id: 'velho', createdAt: iso(T0 - 60 * 60_000), updatedAt: iso(T0 + 5_000) }),
      card({ id: 'novo', sourceStatus: 'in_progress', createdAt: iso(T0 + 1_000), updatedAt: iso(T0 + 1_000) })
    ]
    expect(syncEntregas(e, cards, ctx)).toEqual([
      { id: 'hn-etapa-a', patch: { boardItemId: 'novo', status: 'em_andamento', iniciadaEm: NOW } }
    ])
    expect(entregasWithCardInProgress(e, cards)).toEqual(['hn-etapa-a'])
  })
})

describe('trava de época: cartão anterior ao registro do lote é de outro plano', () => {
  const min = 60_000
  const antigo = card({ id: 'antigo', sourceStatus: 'completed', createdAt: iso(T0 - 5 * min), updatedAt: iso(T0 - 4 * min) })

  it('fora o ligado e o card:<id>, só conta cartão criado a partir do envio (menos a folga de 60 s)', () => {
    const since = iso(T0)
    const dispensado = { ...antigo, id: 'dispensado', dismissedAt: iso(T0 - min) }
    expect(cardForEtapa([antigo], 'etapa-a', { since })).toBeNull()
    expect(cardForEtapa([dispensado], 'etapa-a', { since })).toBeNull()
    // Dentro da folga (relógio de PCs diferentes) ainda conta; um ms antes dela, não.
    expect(cardForEtapa([{ ...antigo, createdAt: iso(T0 - CARD_EPOCH_SLACK_MS) }], 'etapa-a', { since })?.id).toBe('antigo')
    expect(cardForEtapa([{ ...antigo, createdAt: iso(T0 - CARD_EPOCH_SLACK_MS - 1) }], 'etapa-a', { since })).toBeNull()
    // O cartão a que a entrega já está ligada e o citado pelo "Mandar fazer" continuam valendo.
    expect(cardForEtapa([antigo], 'etapa-a', { since, boardItemId: 'antigo' })?.id).toBe('antigo')
    expect(cardForEtapa([antigo], `${CARD_ETAPA_PREFIX}antigo`, { since })?.id).toBe('antigo')
    // Sem época, nada é filtrado.
    expect(cardForEtapa([antigo], 'etapa-a')?.id).toBe('antigo')
  })

  it('[etapa-1] concluído antigo (inclusive dispensado) não conclui a etapa do envio novo', () => {
    const e = envio({ enviadoEm: iso(T0), entregas: [entrega({ etapaId: 'etapa-1' })] })
    for (const old of [antigo, { ...antigo, dismissedAt: iso(T0 - min) }]) {
      const cards = [{ ...old, sourceTitle: '[etapa-1] Do plano anterior' }]
      expect(syncEntregas(e, cards, ctx)).toEqual([])
      expect(turnEndOutcome(e, cards, { now: NOW, turnError: null }).envio).toMatchObject({
        status: 'incompleta',
        motivo: expect.stringContaining('sem cartão no Quadro com o prefixo [etapa-1]')
      })
    }
    // O marco é o registro do lote, saído ou ainda na fila.
    const queued = envio({ enviadoEm: null, criadoEm: iso(T0), entregas: [entrega({ etapaId: 'etapa-1' })] })
    expect(syncEntregas(queued, [{ ...antigo, sourceTitle: '[etapa-1] Do plano anterior' }], ctx)).toEqual([])
  })

  it('o marco é o REGISTRO do lote (criadoEm), não a saída: [etapa-3] criado no turno do prompt 1 conclui a entrega do prompt 3', () => {
    // Lote registrado em T0; o agente declara o roteiro inteiro no 1º prompt; o prompt 3 só sai 40 min depois.
    const e = envio({ criadoEm: iso(T0), enviadoEm: iso(T0 + 40 * min), entregas: [entrega({ etapaId: 'etapa-3' })] })
    const cards = [
      card({ id: 'c3', sourceTitle: '[etapa-3] Fazer 3', sourceStatus: 'completed', createdAt: iso(T0 + 2 * min), updatedAt: iso(T0 + 50 * min) })
    ]
    expect(syncEntregas(e, cards, ctx).map((p) => [p.patch.boardItemId, p.patch.status])).toEqual([['c3', 'concluida']])
    // O motivo do que falta lê o mesmo cartão (não "sem cartão").
    expect(describeMissing(e, [{ ...cards[0], sourceStatus: 'pending' }])).toContain('[etapa-3] Título de etapa-3 — cartão a fazer')
    // O de um lote registrado antes deste continua fora, mesmo com o envio saindo depois.
    const anterior = [{ ...cards[0], createdAt: iso(T0 - 2 * min) }]
    expect(syncEntregas(e, anterior, ctx)).toEqual([])
    expect(describeMissing(e, anterior)).toContain('sem cartão no Quadro com o prefixo [etapa-3]')
  })

  it('o cartão ligado antigo continua valendo para a entrega', () => {
    const e = envio({ enviadoEm: iso(T0), entregas: [entrega({ boardItemId: 'antigo', status: 'em_andamento' })] })
    expect(syncEntregas(e, [antigo], ctx).map((p) => p.patch.status)).toEqual(['concluida'])
  })
})
