// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { HandoffEnvioStatus } from '../../shared/handoffTracking'
import { BOARD_TURN_END_REASON, boardTurnEndReason } from '../../shared/ipc'
import { STALL_ABORT_MS } from '../stallWatch'
import {
  blockReason,
  cardForEtapa,
  conversationLastWriteMs,
  correctionPatch,
  currentEnvio,
  describeMissing,
  entregaCardPatch,
  entregasWithCardInProgress,
  envioAfterCorrection,
  envioForHash,
  errorPatch,
  etapaIdFromTitle,
  HANDOFF_STALL_MS,
  incompleteRefresh,
  isRecoverableError,
  permissionPatch,
  poContestReason,
  stallReason,
  syncEntregas,
  timeDistribution,
  turnEndOutcome,
  turnStartPatch
} from './handoffRules'
import { card, entrega, envio, iso, T0 } from './handoffTestKit'

const NOW = iso(T0 + 60_000)
const ctx = { now: NOW, poEnabled: true }

describe('cartão ↔ entrega pelo prefixo [id-da-etapa]', () => {
  it.each([
    ['[etapa-1] Levantar requisitos', 'etapa-1'],
    ['   [Etapa-1] Com espaço e maiúscula', 'etapa-1'],
    ['[registro-no-banco]Sem espaço', 'registro-no-banco'],
    ['etapa-1 sem colchetes', null],
    ['Rodar os testes', null],
    ['[a b] id com espaço', null],
    ['', null]
  ])('etapaIdFromTitle(%j) = %j', (title, id) => {
    expect(etapaIdFromTitle(title)).toBe(id)
  })

  it('acha o cartão pelo título do agente ou do PO; ignora dispensado, subitem e prefixo parecido', () => {
    const cards = [
      card({ id: 'sub', sourceTitle: 'Rodar os testes' }),
      card({ id: 'outra', sourceTitle: '[etapa-10] Outra etapa' }),
      card({ id: 'dispensado', sourceTitle: '[etapa-1] Velho', dismissedAt: iso(T0) }),
      card({ id: 'po', sourceTitle: 'Etapa um', poTitle: '[etapa-1] Etapa um, legível' })
    ]
    expect(cardForEtapa(cards, 'etapa-1')?.id).toBe('po')
    expect(cardForEtapa(cards, 'etapa-10')?.id).toBe('outra')
    expect(cardForEtapa(cards, 'etapa-2')).toBeNull()
  })

  it('vários cartões da mesma etapa: vale o atualizado por último', () => {
    const cards = [
      card({ id: 'novo', sourceTitle: '[etapa-a] B', updatedAt: iso(T0 + 5_000) }),
      card({ id: 'velho', sourceTitle: '[etapa-a] A', updatedAt: iso(T0) })
    ]
    expect(cardForEtapa(cards, 'etapa-a')?.id).toBe('novo')
  })
})

describe('contestação do PO', () => {
  it('o agente concluiu e o PO sobrepôs outro status: é contestação, com o motivo dele', () => {
    const c = card({ sourceStatus: 'completed', poStatus: 'pending', poReason: 'faltou o teste do caso vazio' })
    expect(poContestReason(c)).toBe('faltou o teste do caso vazio')
    expect(blockReason(c, 'etapa-a')).toBe('o PO contestou: faltou o teste do caso vazio')
  })

  it('NÃO é contestação: fim de turno, arrasto do usuário, PO de acordo, agente sem concluir', () => {
    const turnEnd = card({ sourceStatus: 'completed', poStatus: 'pending', poReason: boardTurnEndReason('result', 'falta x') })
    const userMove = card({
      sourceStatus: 'completed',
      poStatus: 'pending',
      poReason: 'o usuário moveu o cartão para "a fazer" pelo quadro'
    })
    expect(poContestReason(turnEnd)).toBeNull()
    expect(poContestReason(userMove)).toBeNull()
    expect(poContestReason(card({ sourceStatus: 'completed', poStatus: 'completed', poReason: 'ok' }))).toBeNull()
    expect(poContestReason(card({ sourceStatus: 'in_progress', poStatus: 'pending', poReason: 'x' }))).toBeNull()
    expect(poContestReason(card({ sourceStatus: 'completed', poStatus: 'pending', poReason: null }))).toBe('sem motivo registrado')
  })

  it('motivo de quem não concluiu: sem cartão, a fazer (com o fim de turno), em andamento', () => {
    expect(blockReason(null, 'etapa-x')).toBe('sem cartão no Quadro com o prefixo [etapa-x]')
    expect(blockReason(card({ sourceStatus: 'in_progress', poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result }), 'a')).toBe(
      `cartão a fazer (${BOARD_TURN_END_REASON.result})`
    )
    expect(blockReason(card({ sourceStatus: 'in_progress' }), 'a')).toBe('cartão em andamento')
    expect(blockReason(card(), 'a')).toBe('cartão a fazer')
  })
})

describe('entrega acompanhando o cartão', () => {
  it('em andamento: em_andamento, iniciada agora e o cartão ligado', () => {
    const patch = entregaCardPatch(entrega(), card({ sourceStatus: 'in_progress' }), ctx)
    expect(patch).toEqual({ boardItemId: 'bi-1', status: 'em_andamento', iniciadaEm: NOW })
  })

  it('concluído e não contestado: concluida, auditada = PO ligado, tempo corrido do início ao fim', () => {
    const started = entrega({ status: 'em_andamento', iniciadaEm: iso(T0), boardItemId: 'bi-1' })
    expect(entregaCardPatch(started, card({ sourceStatus: 'completed' }), ctx)).toEqual({
      status: 'concluida',
      concluidaEm: NOW,
      auditada: true,
      tempoCorridoMs: 60_000
    })
    expect(entregaCardPatch(started, card({ sourceStatus: 'completed' }), { now: NOW, poEnabled: false })).toMatchObject({
      auditada: false
    })
    // Concluída sem início visto: corrido 0.
    expect(entregaCardPatch(entrega(), card({ sourceStatus: 'completed' }), ctx)).toMatchObject({ tempoCorridoMs: 0 })
  })

  it('contestada pelo PO: volta a pendente com o motivo dele e perde a conclusão', () => {
    const done = entrega({ status: 'concluida', concluidaEm: iso(T0), auditada: true, tempoCorridoMs: 10, boardItemId: 'bi-1' })
    const patch = entregaCardPatch(done, card({ sourceStatus: 'completed', poStatus: 'pending', poReason: 'sem teste' }), ctx)
    expect(patch).toEqual({
      status: 'pendente',
      motivo: 'o PO contestou: sem teste',
      concluidaEm: null,
      auditada: null,
      tempoCorridoMs: null
    })
  })

  it('incompleta continua incompleta enquanto o cartão não anda; só o motivo é relido', () => {
    const missing = entrega({ status: 'incompleta', motivo: 'cartão a fazer', boardItemId: 'bi-1' })
    const justified = card({ sourceStatus: 'in_progress', poStatus: 'pending', poReason: boardTurnEndReason('result', 'falta o build') })
    expect(entregaCardPatch(missing, justified, ctx)).toEqual({
      motivo: `cartão a fazer (${BOARD_TURN_END_REASON.result} — falta o build)`
    })
    expect(entregaCardPatch(missing, card({ sourceStatus: 'in_progress' }), ctx)).toMatchObject({ status: 'em_andamento', motivo: null })
  })

  it('corrigida pelo usuário, sem cartão ou já igual: nada a gravar', () => {
    expect(entregaCardPatch(entrega({ corrigidoPor: 'usuario' }), card({ sourceStatus: 'completed' }), ctx)).toBeNull()
    expect(entregaCardPatch(entrega(), null, ctx)).toBeNull()
    expect(entregaCardPatch(entrega({ boardItemId: 'bi-1' }), card(), ctx)).toBeNull()
  })

  it('syncEntregas e o destino do retrabalho percorrem as entregas do envio', () => {
    const e = envio({ entregas: [entrega({ etapaId: 'a' }), entrega({ etapaId: 'b', ordem: 2 })] })
    const cards = [card({ id: 'ca', sourceTitle: '[a] A', sourceStatus: 'in_progress' }), card({ id: 'cb', sourceTitle: '[b] B' })]
    expect(syncEntregas(e, cards, ctx).map((p) => [p.id, p.patch.status])).toEqual([
      ['hn-a', 'em_andamento'],
      ['hn-b', undefined]
    ])
    expect(entregasWithCardInProgress(e, cards)).toEqual(['hn-a'])
  })
})

describe('critério concluída / incompleta no fim do turno', () => {
  const two = (a: Partial<ReturnType<typeof entrega>>, b: Partial<ReturnType<typeof entrega>>) =>
    envio({ entregas: [entrega({ etapaId: 'a', ...a }), entrega({ etapaId: 'b', ordem: 2, ...b })] })

  it('todas concluídas e turno sem erro: concluida', () => {
    const outcome = turnEndOutcome(two({ status: 'concluida' }, { status: 'concluida' }), [], { now: NOW, turnError: null })
    expect(outcome).toEqual({ envio: { status: 'concluida', concluidoEm: NOW, motivo: null }, entregas: [] })
  })

  it('faltou uma: incompleta dizendo qual e por quê; a entrega também fica incompleta', () => {
    const cards = [card({ sourceTitle: '[b] B', sourceStatus: 'in_progress', poStatus: 'pending', poReason: BOARD_TURN_END_REASON.result })]
    const outcome = turnEndOutcome(two({ status: 'concluida' }, {}), cards, { now: NOW, turnError: null })
    const why = `cartão a fazer (${BOARD_TURN_END_REASON.result})`
    expect(outcome.envio).toEqual({ status: 'incompleta', concluidoEm: null, motivo: `faltou 1 de 2 entregas: [b] Título de b — ${why}` })
    expect(outcome.entregas).toEqual([{ id: 'hn-b', patch: { status: 'incompleta', motivo: why } }])
    expect(outcome.envio.motivo).not.toMatch(/contestou/)
  })

  it('sem cartão e contestada: cada uma com o seu motivo', () => {
    const cards = [card({ sourceTitle: '[a] A', sourceStatus: 'completed', poStatus: 'pending', poReason: 'não rodou o build' })]
    const motivo = turnEndOutcome(two({}, {}), cards, { now: NOW, turnError: null }).envio.motivo
    expect(motivo).toBe(
      'faltou 2 de 2 entregas: [a] Título de a — o PO contestou: não rodou o build; [b] Título de b — sem cartão no Quadro com o prefixo [b]'
    )
  })

  it('envio sem entregas: o turno decide sozinho', () => {
    expect(turnEndOutcome(envio({ entregas: [] }), [], { now: NOW, turnError: null }).envio.status).toBe('concluida')
    expect(turnEndOutcome(envio({ entregas: [] }), [], { now: NOW, turnError: 'Interrompido' }).envio).toEqual({
      status: 'incompleta',
      concluidoEm: null,
      motivo: 'o turno terminou com erro: Interrompido'
    })
  })

  it('entrega reaberta pelo usuário conta como faltando, mas não é reescrita', () => {
    const e = two({ status: 'concluida' }, { status: 'pendente', corrigidoPor: 'usuario', motivo: 'corrigido por você: refazer' })
    const outcome = turnEndOutcome(e, [], { now: NOW, turnError: null })
    expect(outcome.entregas).toEqual([])
    expect(outcome.envio.motivo).toBe('faltou 1 de 2 entregas: [b] Título de b — corrigido por você: refazer')
  })

  it('veredito tardio do PO conclui a última entrega: o envio incompleto vira concluído', () => {
    const late = two({ status: 'concluida' }, { status: 'concluida' })
    const opts = { now: NOW, completedNow: true, turnRunning: false }
    expect(incompleteRefresh({ ...late, status: 'incompleta', motivo: 'faltou' }, [], opts)).toEqual({
      status: 'concluida',
      concluidoEm: NOW,
      motivo: null
    })
    expect(incompleteRefresh({ ...late, status: 'incompleta' }, [], { ...opts, turnRunning: true })).toBeNull()
    expect(incompleteRefresh({ ...late, status: 'incompleta' }, [], { ...opts, completedNow: false })).toBeNull()
    const still = { ...two({ status: 'concluida' }, {}), status: 'incompleta' as const, motivo: 'velho' }
    expect(incompleteRefresh(still, [], opts)).toEqual({ motivo: describeMissing(still, []) })
    expect(incompleteRefresh({ ...still, motivo: 'o turno terminou com erro: x' }, [], opts)).toBeNull()
  })

  it('turno que terminou com ERRO nunca vira concluído pela releitura, nem com o veredito tardio do PO', () => {
    const late = two({ status: 'concluida' }, { status: 'concluida' })
    const motivo = 'o turno terminou com erro: error_during_execution — faltou 1 de 2 entregas: [b] Título de b — cartão a fazer'
    const opts = { now: NOW, completedNow: true, turnRunning: false }
    expect(incompleteRefresh({ ...late, status: 'incompleta', motivo }, [], opts)).toBeNull()
    expect(incompleteRefresh({ ...late, status: 'incompleta', motivo: 'o turno terminou com erro: x' }, [], opts)).toBeNull()
  })
})

describe('envio corrente, casamento pelo hash e transições', () => {
  const sent = (id: string, at: number, over = {}) => envio({ id, enviadoEm: iso(at), ...over })

  it('corrente = o mais recente já enviado; na fila e parada que nunca saiu não contam', () => {
    const envios = [
      sent('a', T0, { status: 'concluida' }),
      sent('b', T0 + 10, { ordem: 2, status: 'incompleta' }),
      envio({ id: 'c', ordem: 3, status: 'na_fila', enviadoEm: null }),
      envio({ id: 'd', ordem: 4, status: 'parada', enviadoEm: null })
    ]
    expect(currentEnvio(envios)?.id).toBe('b')
    expect(currentEnvio([envios[2], envios[3]])).toBeNull()
  })

  it('o hash casa o envio ainda não enviado (na fila ou parado na fila), do lote mais novo', () => {
    const envios = [
      envio({ id: 'velho', status: 'na_fila', enviadoEm: null, conteudoHash: 'h', criadoEm: iso(T0) }),
      envio({ id: 'novo', status: 'parada', enviadoEm: null, conteudoHash: 'h', criadoEm: iso(T0 + 1) }),
      envio({ id: 'saiu', status: 'enviado', conteudoHash: 'h', criadoEm: iso(T0 + 2) })
    ]
    expect(envioForHash(envios, 'h')?.id).toBe('novo')
    expect(envioForHash(envios, 'outro')).toBeNull()
  })

  it('turn-start: volta a rodar (ou espera você); concluído e na fila não mudam', () => {
    expect(turnStartPatch(envio({ status: 'enviado', iniciadoEm: null }), NOW, false)).toEqual({ status: 'em_execucao', iniciadoEm: NOW })
    expect(turnStartPatch(envio({ status: 'incompleta', motivo: 'x' }), NOW, false)).toEqual({ status: 'em_execucao', motivo: null })
    expect(turnStartPatch(envio({ status: 'parada', motivo: 'x' }), NOW, true)).toEqual({ status: 'aguardando_voce', motivo: null })
    expect(turnStartPatch(envio({ status: 'em_execucao' }), NOW, false)).toBeNull()
    expect(turnStartPatch(envio({ status: 'concluida' }), NOW, false)).toBeNull()
    expect(turnStartPatch(envio({ status: 'na_fila', enviadoEm: null }), NOW, false)).toBeNull()
  })

  it('pergunta aberta ↔ rodando; erro retomável não é falha; outro erro é', () => {
    expect(permissionPatch(envio({ status: 'em_execucao' }), true)).toEqual({ status: 'aguardando_voce' })
    expect(permissionPatch(envio({ status: 'aguardando_voce' }), false)).toEqual({ status: 'em_execucao' })
    expect(permissionPatch(envio({ status: 'enviado' }), true)).toBeNull()
    expect(isRecoverableError({ incomplete: true, retryable: true })).toBe(true)
    expect(isRecoverableError({ incomplete: true })).toBe(false)
    expect(isRecoverableError({ retryable: true })).toBe(false)
    expect(isRecoverableError({ incomplete: true, retryable: false })).toBe(false)
    expect(errorPatch(envio(), 'Agent stopped: boom')).toEqual({ status: 'falhou', motivo: 'Agent stopped: boom' })
    expect(errorPatch(envio(), 'x'.repeat(900))?.motivo).toHaveLength(500)
    expect(errorPatch(envio({ status: 'concluida' }), 'boom')).toBeNull()
  })
})

describe('tempo', () => {
  const e = envio({
    entregas: [entrega({ etapaId: 'a', status: 'em_andamento' }), entrega({ etapaId: 'b', ordem: 2, status: 'concluida' })]
  })

  it('não concluído: tempo ativo do envio e das entregas em andamento', () => {
    expect(timeDistribution(e, 1500.4, new Set())).toEqual({ envioId: 'he-1', ativoMs: 1500, entregas: [{ id: 'hn-a', ativoMs: 1500 }] })
  })

  it('concluído: retrabalho do envio e das entregas cujo cartão voltou a andar', () => {
    expect(timeDistribution({ ...e, status: 'concluida' }, 2000, new Set(['hn-b']))).toEqual({
      envioId: 'he-1',
      retrabalhoMs: 2000,
      entregas: [{ id: 'hn-b', retrabalhoMs: 2000 }]
    })
  })

  it('fatia zero ou inválida: nada a gravar', () => {
    expect(timeDistribution(e, 0, new Set())).toBeNull()
    expect(timeDistribution(e, Number.NaN, new Set())).toBeNull()
  })
})

describe('parada', () => {
  const base = { turnRunning: false, pending: false, lastActivityMs: T0, now: T0 + HANDOFF_STALL_MS }
  const quiet = (status: HandoffEnvioStatus) => envio({ status, updatedAt: iso(T0) })

  it('o limite é o mesmo do travamento definitivo do turno (10 min)', () => {
    expect(HANDOFF_STALL_MS).toBe(STALL_ABORT_MS)
    expect(HANDOFF_STALL_MS).toBe(10 * 60_000)
  })

  it('na fila, enviado e em execução sem turno há 10 min: parada, com o porquê', () => {
    expect(stallReason(quiet('na_fila'), base)).toBe('o prompt ficou 10 min na fila sem ser enviado')
    expect(stallReason(quiet('enviado'), base)).toBe('o prompt foi enviado, mas nenhum turno começou em 10 min')
    expect(stallReason(quiet('em_execucao'), base)).toBe('nenhum turno rodando há 10 min, sem pergunta pendente e sem conclusão')
  })

  it('antes do limite, com turno, com pergunta aberta ou já terminado: não', () => {
    expect(stallReason(quiet('enviado'), { ...base, now: base.now - 1 })).toBeNull()
    expect(stallReason(quiet('enviado'), { ...base, turnRunning: true })).toBeNull()
    expect(stallReason(quiet('enviado'), { ...base, pending: true })).toBeNull()
    expect(stallReason(quiet('aguardando_voce'), { ...base, pending: true })).toBeNull()
    for (const status of ['parada', 'falhou', 'incompleta', 'concluida'] as const) {
      expect(stallReason(quiet(status), base)).toBeNull()
    }
  })

  it('esperando você sem pergunta aberta em memória (o app fechou e reabriu): também para', () => {
    expect(stallReason(quiet('aguardando_voce'), base)).toBe(
      'esperava você, mas não há pergunta aberta nem turno rodando há 10 min'
    )
    expect(stallReason(quiet('aguardando_voce'), { ...base, now: base.now - 1 })).toBeNull()
  })

  it('escrita recente no envio (outro PC rodando) conta como atividade', () => {
    expect(stallReason(envio({ status: 'em_execucao', updatedAt: iso(T0 + 60_000) }), base)).toBeNull()
  })

  it('banco compartilhado: a escrita mais recente em QUALQUER envio da conversa é atividade dela', () => {
    const running = envio({ id: 'a', status: 'em_execucao', updatedAt: iso(T0 + 9 * 60_000) })
    const queued = envio({ id: 'b', ordem: 2, status: 'na_fila', enviadoEm: null, updatedAt: iso(T0) })
    expect(conversationLastWriteMs([queued, running])).toBe(T0 + 9 * 60_000)
    expect(conversationLastWriteMs([])).toBe(0)
    const conv = { ...base, lastActivityMs: Math.max(base.lastActivityMs, conversationLastWriteMs([running, queued])) }
    expect(stallReason(queued, base)).not.toBeNull()
    expect(stallReason(queued, conv)).toBeNull()
  })
})

describe('correção manual', () => {
  it('concluir: concluída pelo usuário, com o motivo dele; reabrir limpa a conclusão', () => {
    const started = entrega({ iniciadaEm: iso(T0) })
    expect(correctionPatch(started, 'concluir', '  feito à mão  ', NOW)).toEqual({
      corrigidoPor: 'usuario',
      corrigidoEm: NOW,
      motivo: 'corrigido por você: feito à mão',
      status: 'concluida',
      concluidaEm: NOW,
      auditada: false,
      tempoCorridoMs: 60_000
    })
    expect(correctionPatch(entrega({ status: 'concluida', concluidaEm: iso(T0) }), 'reabrir', undefined, NOW)).toEqual({
      corrigidoPor: 'usuario',
      corrigidoEm: NOW,
      motivo: 'corrigido por você',
      status: 'pendente',
      concluidaEm: null,
      auditada: null,
      tempoCorridoMs: null
    })
  })

  it('reavalia o envio: todas concluídas → concluída; reabrir num concluído → incompleta; na fila não muda', () => {
    const done = envio({ status: 'incompleta', entregas: [entrega({ status: 'concluida' })] })
    expect(envioAfterCorrection(done, 'concluir', [], NOW)).toEqual({ status: 'concluida', concluidoEm: NOW, motivo: null })
    const reopened = envio({ status: 'concluida', concluidoEm: iso(T0), entregas: [entrega({ status: 'pendente', corrigidoPor: 'usuario', motivo: 'corrigido por você' })] })
    expect(envioAfterCorrection(reopened, 'reabrir', [], NOW)).toEqual({
      status: 'incompleta',
      concluidoEm: null,
      motivo: 'faltou 1 de 1 entrega: [etapa-a] Título de etapa-a — corrigido por você'
    })
    expect(envioAfterCorrection({ ...done, status: 'na_fila', enviadoEm: null }, 'concluir', [], NOW)).toBeNull()
  })
})
