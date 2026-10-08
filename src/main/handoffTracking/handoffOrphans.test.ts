// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../../shared/ipc'
import { orphanEtapas } from './handoffOrphans'
import { CARD_EPOCH_SLACK_MS, entregaCard } from './handoffRules'
import { card, entrega, envio, iso, T0 } from './handoffTestKit'
import { CONV, closeHarnesses, harness, type Harness } from './handoffTrackerHarness'

// As etapas do envio corrente SEM cartão no Quadro (handoffOrphans.ts): o que o
// PO recebe no fechamento para criar o cartão `[id]` (FEITA ou NOVA). O cartão
// é achado pelo MESMO casamento do acompanhamento — nunca por outro.

afterEach(closeHarnesses)

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }

describe('orphanEtapas — as entregas abertas sem cartão', () => {
  it('lista [id] e título das entregas abertas sem cartão, na ordem do envio', () => {
    const e = envio({
      entregas: [
        entrega({ etapaId: 'etapa-a' }),
        entrega({ etapaId: 'etapa-b', status: 'em_andamento' }),
        entrega({ etapaId: 'etapa-c', status: 'incompleta' })
      ]
    })
    const cards = [card({ sourceTitle: '[etapa-a] Fazer A' })]
    expect(orphanEtapas(e, cards)).toEqual([
      { etapaId: 'etapa-b', titulo: 'Título de etapa-b' },
      { etapaId: 'etapa-c', titulo: 'Título de etapa-c' }
    ])
  })

  it('fora da lista: a concluída, a corrigida pelo usuário, a `card:<id>` e o id que o prefixo [id] não carrega', () => {
    const e = envio({
      entregas: [
        entrega({ etapaId: 'feita', status: 'concluida' }),
        entrega({ etapaId: 'corrigida', corrigidoPor: 'usuario', status: 'incompleta' }),
        entrega({ etapaId: 'card:bi-sumiu' }),
        entrega({ etapaId: 'com espaco' }),
        entrega({ etapaId: 'x'.repeat(65) }),
        entrega({ etapaId: 'Etapa-OK' })
      ]
    })
    expect(orphanEtapas(e, [])).toEqual([{ etapaId: 'Etapa-OK', titulo: 'Título de Etapa-OK' }])
  })

  it('o MESMO casamento do acompanhamento: outra conversa do projeto, título do PO e dispensado concluído contam', () => {
    const e = envio({ entregas: ['a', 'b', 'c', 'd'].map((id) => entrega({ etapaId: id })) })
    const cards = [
      card({ id: 'outra', conversationId: 'conv-outra', sourceTitle: '[a] Feito noutra conversa' }),
      card({ id: 'po', sourceTitle: 'Título técnico', poTitle: '[b] Título do PO' }),
      card({ id: 'expirado', sourceTitle: '[c] Concluído e expirado', sourceStatus: 'completed', dismissedAt: iso(T0) }),
      card({ id: 'dispensado', sourceTitle: '[d] Dispensado a fazer', dismissedAt: iso(T0) })
    ]
    expect(orphanEtapas(e, cards).map((o) => o.etapaId)).toEqual(['d'])
  })

  it('trava de época: o cartão `[id]` de um plano anterior não fala pela etapa nova — ela é órfã', () => {
    const e = envio({ criadoEm: iso(T0), entregas: [entrega({ etapaId: 'etapa-1' })] })
    const old = card({ id: 'velho', sourceTitle: '[etapa-1] Do plano anterior', createdAt: iso(T0 - CARD_EPOCH_SLACK_MS - 1) })
    expect(orphanEtapas(e, [old])).toEqual([{ etapaId: 'etapa-1', titulo: 'Título de etapa-1' }])
    // O já ligado não passa pela trava.
    const linked = envio({ criadoEm: iso(T0), entregas: [entrega({ etapaId: 'etapa-1', boardItemId: 'velho' })] })
    expect(orphanEtapas(linked, [old])).toEqual([])
  })

  it('o casamento é o entregaCard do acompanhamento: órfã ⇔ ele não acha cartão (o mesmo que o syncEntregas usa)', () => {
    // O lote saiu bem depois do registro: a época é o registro, como no acompanhamento.
    const e = envio({
      criadoEm: iso(T0),
      enviadoEm: iso(T0 + 600_000),
      entregas: ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => entrega({ id: `hn-${id}`, etapaId: id, ordem: i + 1 }))
    })
    const cards = [
      card({ id: 'c-a', sourceTitle: '[a] A', createdAt: iso(T0 + 60_000) }),
      card({ id: 'c-b', sourceTitle: '[b] B velho', createdAt: iso(T0 - CARD_EPOCH_SLACK_MS - 1) }),
      card({ id: 'c-c', conversationId: 'conv-outra', sourceTitle: '[C] C noutra conversa' }),
      card({ id: 'c-d', sourceTitle: '[d] D dispensado', dismissedAt: iso(T0) }),
      card({ id: 'c-e', sourceTitle: 'sem prefixo e' })
    ]
    const orphans = new Set(orphanEtapas(e, cards).map((o) => `hn-${o.etapaId}`))
    for (const en of e.entregas) expect(orphans.has(en.id)).toBe(entregaCard(e, en, cards) === null)
    expect([...orphans].sort()).toEqual(['hn-b', 'hn-d', 'hn-e', 'hn-f'])
  })
})

/** O 1º prompt saiu e o turno dele roda, com o snapshot do agente declarando `tasks`. */
async function running(etapas: string[], tasks: Array<[string, 'pending' | 'in_progress' | 'completed']>): Promise<Harness> {
  const h = await harness()
  await h.register([{ conteudo: 'Prompt 1', etapas }])
  h.tracker.noteUserSend(CONV, 'Prompt 1')
  h.emit(turnStart)
  h.tasks(tasks)
  await h.settle()
  return h
}

describe('HandoffTracker.orphanEtapas — a ponte do PO', () => {
  it('as etapas do envio corrente sem cartão no Quadro do projeto', async () => {
    const h = await running(['a', 'b', 'c'], [['[a] Etapa a', 'in_progress'], ['[c] Etapa c', 'completed']])
    expect(await h.tracker.orphanEtapas(CONV)).toEqual([{ etapaId: 'b', titulo: 'Etapa b' }])
  })

  it('lê FORA da fila da conversa: o fim de turno, na fila, espera o PO — esperar a fila travaria os dois', async () => {
    const h = await running(['a', 'b'], [['[a] Etapa a', 'in_progress']])
    let release!: () => void
    const blocked = h.tracker.exclusive(CONV, () => new Promise<void>((resolve) => (release = resolve)))
    expect(await h.tracker.orphanEtapas(CONV)).toEqual([{ etapaId: 'b', titulo: 'Etapa b' }])
    release()
    await blocked
  })

  it('nunca lança: sem envio corrente, sem banco, banco falhando ou Quadro indisponível → lista vazia', async () => {
    const h = await running(['a'], [])
    expect(await h.tracker.orphanEtapas('conversa-sem-envio')).toEqual([])

    vi.spyOn(h.repo, 'listHandoffEnvios').mockRejectedValueOnce(new Error('banco caiu'))
    expect(await h.tracker.orphanEtapas(CONV)).toEqual([])
    expect(h.logs.some((line) => line.includes('orphanEtapas') && line.includes('banco caiu'))).toBe(true)

    vi.spyOn(h.board, 'list').mockResolvedValueOnce(null)
    expect(await h.tracker.orphanEtapas(CONV)).toEqual([])

    expect(await h.reopen({ repository: () => null }).orphanEtapas(CONV)).toEqual([])
  })
})
