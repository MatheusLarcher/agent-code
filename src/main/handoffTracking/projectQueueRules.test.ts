// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { HandoffEnvio, HandoffEnvioStatus } from '../../shared/handoffTracking'
import {
  PROJECT_REEVALUATE_MS,
  PROJECT_STOP_WAIT_MS,
  dirtyPreamble,
  moveTo,
  passTurn,
  planState,
  projectStep,
  startDecision,
  turnEvaluationDue,
  viewFolder,
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

function views(plans: StoredPlan[], envios: HandoffEnvio[]) {
  return viewFolder(plans, (lote) => envios.filter((e) => e.loteId === lote))
}

describe('planState', () => {
  it('na fila, rodando, entre prompts, parado e terminado', () => {
    expect(planState([envio('a', 'c', 1, 'na_fila')])).toBe('na_fila')
    expect(planState([envio('a', 'c', 1, 'em_execucao'), envio('a', 'c', 2, 'na_fila')])).toBe('rodando')
    expect(planState([envio('a', 'c', 1, 'concluida'), envio('a', 'c', 2, 'na_fila')])).toBe('entre_prompts')
    expect(planState([envio('a', 'c', 1, 'incompleta'), envio('a', 'c', 2, 'na_fila')])).toBe('parado')
    expect(planState([envio('a', 'c', 1, 'aguardando_voce')])).toBe('parado')
    expect(planState([envio('a', 'c', 1, 'concluida'), envio('a', 'c', 2, 'concluida')])).toBe('terminado')
    expect(planState([])).toBe('terminado')
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
