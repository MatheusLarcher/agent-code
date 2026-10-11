// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HANDOFF_CONVERSATION_DELETED_MOTIVO, type HandoffEnvio, type HandoffEnvioStatus } from '../../shared/handoffTracking'
import { BOOT_GRACE_MS } from './handoffActivity'
import {
  PROJECT_QUEUE_LIVE_MS,
  PROJECT_REEVALUATE_MS,
  PROJECT_STOP_WAIT_MS,
  dirtyPreamble,
  minutesWithoutTurn,
  moveTo,
  passTurn,
  planState,
  projectStep,
  startDecision,
  stopReason,
  turnEvaluationDue,
  viewFolder,
  waitingReason,
  type PlanLiveness,
  type StoredPlan
} from './projectQueueRules'

/**
 * As regras puras da fila do projeto: um plano por vez na pasta, sem
 * intercalar; a pasta suja segura o começo; "Começar mesmo assim" e "Passar a
 * vez" só mudam a ordem; o PO entra com o A parado há 30 min.
 */

let seq = 0
function envio(lote: string, conv: string, ordem: number, status: HandoffEnvioStatus, over: Partial<HandoffEnvio> = {}): HandoffEnvio {
  const sent = status !== 'na_fila'
  return {
    id: `${lote}-${ordem}`,
    planSlug: lote,
    planTitulo: `Plano ${lote}`,
    projectId: 'p',
    projectCwd: 'C:/proj',
    conversationId: conv,
    conversationTitle: conv,
    arquivo: `0${ordem}.md`,
    ordem,
    loteId: lote,
    conteudo: `Prompt ${ordem} do ${lote}`,
    conteudoHash: `h${++seq}`,
    status,
    motivo: null,
    estimativaTotal: 30,
    prazoTotal: 30,
    atrasado: false,
    tempoAtivoMs: 0,
    retrabalhoMs: 0,
    criadoEm: '2026-10-06T10:00:00.000Z',
    enviadoEm: sent ? `2026-10-06T10:0${ordem}:00.000Z` : null,
    iniciadoEm: null,
    concluidoEm: status === 'concluida' ? '2026-10-06T11:00:00.000Z' : null,
    updatedAt: '2026-10-06T11:00:00.000Z',
    entregas: [],
    ...over
  }
}

const plan = (lote: string, over: Partial<StoredPlan> = {}): StoredPlan => ({
  loteId: lote,
  conversationId: `conv-${lote}`,
  planTitulo: `Plano ${lote}`,
  addedAt: '2026-10-06T10:00:00.000Z',
  ...over
})

/** O relógio das fábricas: `updatedAt` dos envios. */
const T_UPDATED = Date.parse('2026-10-06T11:00:00.000Z')
/** Sem turno neste processo, mas com a escrita do banco "agora": vivo. */
const ALIVE: PlanLiveness = { turnRunning: () => false, now: T_UPDATED }

function views(plans: StoredPlan[], envios: HandoffEnvio[], live: PlanLiveness = ALIVE) {
  return viewFolder(plans, (lote) => envios.filter((e) => e.loteId === lote), live)
}

describe('planState', () => {
  it('na fila, rodando, entre prompts, parado e terminado', () => {
    expect(planState([envio('a', 'c', 1, 'na_fila')], ALIVE)).toBe('na_fila')
    expect(planState([envio('a', 'c', 1, 'em_execucao'), envio('a', 'c', 2, 'na_fila')], ALIVE)).toBe('rodando')
    expect(planState([envio('a', 'c', 1, 'concluida'), envio('a', 'c', 2, 'na_fila')], ALIVE)).toBe('entre_prompts')
    // Incompleto sem erro: a fila segue sozinha (entre prompts); o que para é erro, Stop, esperando você.
    expect(planState([envio('a', 'c', 1, 'incompleta'), envio('a', 'c', 2, 'na_fila')], ALIVE)).toBe('entre_prompts')
    expect(planState([envio('a', 'c', 1, 'falhou'), envio('a', 'c', 2, 'na_fila')], ALIVE)).toBe('parado')
    expect(planState([envio('a', 'c', 1, 'aguardando_voce')], ALIVE)).toBe('parado')
    expect(planState([envio('a', 'c', 1, 'concluida'), envio('a', 'c', 2, 'concluida')], ALIVE)).toBe('terminado')
    expect(planState([], ALIVE)).toBe('terminado')
  })

  it('conversa apagada: os envios parados com o motivo terminam o plano (ele sai da fila)', () => {
    const deleted = { motivo: HANDOFF_CONVERSATION_DELETED_MOTIVO }
    const envios = [envio('a', 'c', 1, 'parada', deleted), envio('a', 'c', 2, 'parada', { ...deleted, enviadoEm: null })]
    expect(planState(envios, ALIVE)).toBe('terminado')
    expect(views([plan('a')], envios)).toEqual([])
  })
})

describe('planState — "rodando" exige sinal de vida, não só o status gravado', () => {
  const running = [envio('a', 'conv-a', 1, 'em_execucao'), envio('a', 'conv-a', 2, 'na_fila')]
  const later = T_UPDATED + 60 * 60_000

  it('em execução com o turno vivo neste processo → rodando (mesmo com a escrita velha)', () => {
    expect(planState(running, { turnRunning: () => true, now: later })).toBe('rodando')
    expect(planState([envio('a', 'conv-a', 1, 'enviado')], { turnRunning: () => true, now: later })).toBe('rodando')
  })

  it('sem turno e com a escrita velha → parado, com os minutos sem turno', () => {
    const live: PlanLiveness = { turnRunning: () => false, now: later }
    expect(planState(running, live)).toBe('parado')
    expect(minutesWithoutTurn(running[0], live)).toBe(60)
    expect(views([plan('a')], running, live)[0]).toMatchObject({ state: 'parado', semTurnoMin: 60 })
  })

  it('sem turno, mas com a escrita (outro PC) ou a atividade daqui há 1 min → rodando; no limite, parado', () => {
    const fresh = { ...running[0], updatedAt: new Date(later - 60_000).toISOString() }
    expect(planState([fresh, running[1]], { turnRunning: () => false, now: later })).toBe('rodando')
    expect(planState(running, { turnRunning: () => false, lastActivityMs: () => later - 60_000, now: later })).toBe('rodando')
    const edge = { ...running[0], updatedAt: new Date(later - PROJECT_QUEUE_LIVE_MS).toISOString() }
    expect(planState([edge, running[1]], { turnRunning: () => false, now: later })).toBe('parado')
    expect(minutesWithoutTurn(edge, { turnRunning: () => false, now: later })).toBe(3)
    expect(views([plan('a')], running, ALIVE)[0].semTurnoMin).toBeUndefined()
  })

  it('carência do boot (a mesma da varredura): sem turno nem escrita, o plano segue rodando até ela passar; depois, parado', () => {
    const bootedAt = later - BOOT_GRACE_MS + 1
    const inGrace: PlanLiveness = { turnRunning: () => false, bootedAt, now: later }
    expect(minutesWithoutTurn(running[0], inGrace)).toBeNull()
    expect(planState(running, inGrace)).toBe('rodando')
    expect(planState([envio('a', 'conv-a', 1, 'enviado')], inGrace)).toBe('rodando')
    expect(views([plan('a')], running, inGrace)[0]).toMatchObject({ state: 'rodando' })
    // A carência passou e nada deu sinal de vida: parado, com os minutos desde a última atividade (não desde o boot).
    const after: PlanLiveness = { ...inGrace, now: bootedAt + BOOT_GRACE_MS }
    expect(planState(running, after)).toBe('parado')
    expect(minutesWithoutTurn(running[0], after)).toBe(60)
    // Sem `bootedAt` (sem carência): o que já valia.
    expect(planState(running, { turnRunning: () => false, now: later })).toBe('parado')
  })

  it('o motivo diz "sem turno rodando há N min": para quem espera a vez e para o PO', () => {
    const live: PlanLiveness = { turnRunning: () => false, now: later }
    const v = views([plan('a'), plan('b')], [...running, envio('b', 'conv-b', 1, 'na_fila')], live)
    expect(waitingReason(2, v[0])).toBe('na fila do projeto (2º): esperando o plano "Plano a" terminar — ele consta rodando, mas está sem turno rodando há 60 min')
    expect(stopReason(v[0])).toBe('o prompt 1 de 2 (01.md) consta rodando no banco, mas está sem turno rodando há 60 min')
    expect(projectStep(v, 'b')).toMatchObject({ kind: 'decided', decision: { kind: 'hold', motivo: expect.stringContaining('sem turno rodando há 60 min') } })
    // O próprio A: o motivo não é "ainda está rodando" — é a falta de turno (a tela oferece "Enviar mesmo assim").
    expect(projectStep(v, 'a')).toMatchObject({
      kind: 'decided',
      decision: { kind: 'hold', envio: { id: 'a-2' }, motivo: 'o prompt anterior consta rodando, mas está sem turno rodando há 60 min' }
    })
  })
})

describe('projectStep — um plano por vez na pasta', () => {
  it('o B espera o A, que está rodando; o A segue a regra da fila do quadro', () => {
    const v = views([plan('a'), plan('b')], [envio('a', 'conv-a', 1, 'em_execucao'), envio('a', 'conv-a', 2, 'na_fila'), envio('b', 'conv-b', 1, 'na_fila')])
    expect(projectStep(v, 'b')).toEqual({
      kind: 'decided',
      decision: { kind: 'hold', envio: expect.objectContaining({ id: 'b-1' }), motivo: 'na fila do projeto (2º): esperando o plano "Plano a" terminar' }
    })
    expect(projectStep(v, 'a')).toMatchObject({ kind: 'decided', decision: { kind: 'hold', motivo: expect.stringContaining('ainda está rodando') } })
  })

  it('planos não se intercalam: o A entre prompts solta o 2º dele, nunca o 1º do B', () => {
    const v = views([plan('a'), plan('b')], [envio('a', 'conv-a', 1, 'concluida'), envio('a', 'conv-a', 2, 'na_fila'), envio('b', 'conv-b', 1, 'na_fila')])
    expect(projectStep(v, 'a')).toMatchObject({ kind: 'decided', decision: { kind: 'next', envio: { id: 'a-2' } } })
    expect(projectStep(v, 'b')).toMatchObject({ kind: 'decided', decision: { kind: 'hold' } })
  })

  it('o A terminou: a vez é do B, que começa pela pasta (o serviço confere o git)', () => {
    const v = views([plan('a'), plan('b')], [envio('a', 'conv-a', 1, 'concluida'), envio('b', 'conv-b', 1, 'na_fila'), envio('b', 'conv-b', 2, 'na_fila')])
    expect(v.map((x) => x.plan.loteId)).toEqual(['b'])
    expect(projectStep(v, 'b')).toMatchObject({ kind: 'start', first: { id: 'b-1' } })
  })

  it('com a vez, mas outro plano ainda roda um prompt: espera o prompt atual dele', () => {
    // O A recuperou a vez (RETOMAR_A) com o B no meio de um prompt.
    const v = views([plan('a'), plan('b')], [envio('a', 'conv-a', 1, 'incompleta'), envio('a', 'conv-a', 2, 'na_fila'), envio('b', 'conv-b', 1, 'em_execucao')])
    expect(projectStep(v, 'a')).toMatchObject({
      kind: 'decided',
      decision: { kind: 'hold', motivo: 'esperando o prompt atual do plano "Plano b" terminar' }
    })
  })

  it('plano fora da fila (terminado) não decide nada', () => {
    const v = views([plan('a')], [envio('a', 'conv-a', 1, 'concluida')])
    expect(projectStep(v, 'a')).toEqual({ kind: 'decided', decision: { kind: 'none' } })
  })

  it('"mesmo assim" (force) vence a vez de outro plano e o outro rodando: é o usuário mandando', () => {
    // O B atrás do A, que roda: sem force espera; com force, começa (o serviço confere a pasta).
    const v = views([plan('a'), plan('b')], [envio('a', 'conv-a', 1, 'em_execucao'), envio('a', 'conv-a', 2, 'na_fila'), envio('b', 'conv-b', 1, 'na_fila')])
    expect(projectStep(v, 'b')).toMatchObject({ kind: 'decided', decision: { kind: 'hold' } })
    expect(projectStep(v, 'b', { force: true })).toMatchObject({ kind: 'start', first: { id: 'b-1' } })
    // O A com a vez, mas o B ainda roda: force solta o 2º do A pela regra da fila do quadro (que o force também vence).
    const w = views([plan('a'), plan('b')], [envio('a', 'conv-a', 1, 'incompleta'), envio('a', 'conv-a', 2, 'na_fila'), envio('b', 'conv-b', 1, 'em_execucao')])
    expect(projectStep(w, 'a')).toMatchObject({ kind: 'decided', decision: { kind: 'hold' } })
    expect(projectStep(w, 'a', { force: true })).toMatchObject({ kind: 'decided', decision: { kind: 'next', envio: { id: 'a-2' } } })
    // O B que já começou e espera atrás do A: force solta o 2º dele também.
    const x = views([plan('a'), plan('b')], [envio('a', 'conv-a', 1, 'em_execucao'), envio('b', 'conv-b', 1, 'concluida'), envio('b', 'conv-b', 2, 'na_fila')])
    expect(projectStep(x, 'b', { force: true })).toMatchObject({ kind: 'decided', decision: { kind: 'next', envio: { id: 'b-2' } } })
  })
})

describe('startDecision — a pasta suja segura o começo', () => {
  const v = views([plan('b')], [envio('b', 'conv-b', 1, 'na_fila')])
  const first = v[0].envios[0]

  it('mudanças sem commit seguram com "N arquivos sem commit"', () => {
    expect(startDecision(v[0], first, ['a.ts', 'b.ts'])).toEqual({
      kind: 'hold',
      envio: expect.objectContaining({ id: 'b-1' }),
      motivo: '2 arquivos sem commit nesta pasta'
    })
    expect(startDecision(v[0], first, ['a.ts'])).toMatchObject({ motivo: '1 arquivo sem commit nesta pasta' })
  })

  it('pasta limpa (ou sem git) começa; "Começar mesmo assim" começa com a pasta suja', () => {
    expect(startDecision(v[0], first, [])).toMatchObject({ kind: 'next', envio: { conteudo: 'Prompt 1 do b' } })
    expect(startDecision(v[0], first, null)).toMatchObject({ kind: 'next' })
    const anyway = { ...v[0], plan: plan('b', { startAnyway: { by: 'usuario', at: 'x' } }) }
    expect(startDecision(anyway, first, ['a.ts'])).toMatchObject({ kind: 'next' })
  })

  it('o PO começou com a pasta suja: o 1º prompt leva a lista dos arquivos do A, montada pelo código', () => {
    const byPo = { ...v[0], plan: plan('b', { startAnyway: { by: 'po', at: 'x' }, dirtyFromPrevious: { planTitulo: 'Plano a', files: ['src/x.ts', 'src/y.ts'] } }) }
    const decision = startDecision(byPo, first, ['src/x.ts', 'src/y.ts'])
    if (decision.kind !== 'next') throw new Error('esperava o 1º prompt')
    expect(decision.envio.conteudo).toBe(`${dirtyPreamble({ planTitulo: 'Plano a', files: ['src/x.ts', 'src/y.ts'] })}Prompt 1 do b`)
    expect(decision.envio.conteudo).toContain('NÃO edite nem commite estes arquivos')
    expect(decision.envio.conteudo).toContain('- src/x.ts\n- src/y.ts')
  })
})

describe('a ordem: Começar mesmo assim e Passar a vez', () => {
  it('moveTo leva o plano para a frente sem mudar a ordem dos outros', () => {
    expect(moveTo([plan('a'), plan('b'), plan('c')], 'c', 0).map((p) => p.loteId)).toEqual(['c', 'a', 'b'])
  })

  it('passar a vez põe o A logo depois do próximo plano vivo', () => {
    const plans = [plan('a'), plan('morto'), plan('b'), plan('c')]
    const v = views(plans, [envio('a', 'conv-a', 1, 'incompleta'), envio('morto', 'x', 1, 'concluida'), envio('b', 'conv-b', 1, 'na_fila'), envio('c', 'conv-c', 1, 'na_fila')])
    expect(passTurn(plans, v, 'a').map((p) => p.loteId)).toEqual(['morto', 'b', 'a', 'c'])
  })
})

describe('turnEvaluationDue — 30 min parado, depois só com mudança', () => {
  const stopped = views([plan('a'), plan('b')], [envio('a', 'conv-a', 1, 'incompleta'), envio('b', 'conv-b', 1, 'na_fila')])
  const t0 = 1_000_000

  it('só com o A parado há 30 min e alguém esperando', () => {
    expect(turnEvaluationDue({ views: stopped, stoppedSince: t0, now: t0 + PROJECT_STOP_WAIT_MS - 1, last: null })).toBe(false)
    expect(turnEvaluationDue({ views: stopped, stoppedSince: t0, now: t0 + PROJECT_STOP_WAIT_MS, last: null })).toBe(true)
    const running = views([plan('a'), plan('b')], [envio('a', 'conv-a', 1, 'em_execucao'), envio('b', 'conv-b', 1, 'na_fila')])
    expect(turnEvaluationDue({ views: running, stoppedSince: t0, now: t0 + PROJECT_STOP_WAIT_MS, last: null })).toBe(false)
    expect(turnEvaluationDue({ views: stopped.slice(0, 1), stoppedSince: t0, now: t0 + PROJECT_STOP_WAIT_MS, last: null })).toBe(false)
  })

  it('depois de um ESPERAR: no máximo a cada 30 min, e só se algo mudou', () => {
    const at = t0 + PROJECT_STOP_WAIT_MS
    const last = { loteA: 'a', loteB: 'b', decisao: 'ESPERAR', at, signature: 'sig-1' }
    const base = { views: stopped, stoppedSince: t0, last }
    expect(turnEvaluationDue({ ...base, now: at + PROJECT_REEVALUATE_MS - 1, signature: 'sig-2' })).toBe(false)
    expect(turnEvaluationDue({ ...base, now: at + PROJECT_REEVALUATE_MS, signature: 'sig-1' })).toBe(false)
    expect(turnEvaluationDue({ ...base, now: at + PROJECT_REEVALUATE_MS, signature: 'sig-2' })).toBe(true)
    // Outro par (um plano novo entrou na frente): a regra dos 30 min vale de novo.
    expect(turnEvaluationDue({ ...base, last: { ...last, loteB: 'c' }, now: at + 1, signature: 'sig-1' })).toBe(true)
  })
})
