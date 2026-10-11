import { describe, expect, it } from 'vitest'
import type { HandoffEntrega, HandoffEnvio } from '../../shared/handoffTracking'
import {
  dueScrumMark,
  firedFromLog,
  noteFired,
  scrumEscala,
  scrumEsperaMs,
  scrumPrazoMs,
  travadoDue,
  type ScrumFired
} from './scrumMarks'
import type { ScrumDecisao, ScrumMarco } from './scrumTypes'

const MIN = 60_000
const AT = '2026-10-11T12:00:00.000Z'

function entrega(over: Partial<HandoffEntrega> = {}): HandoffEntrega {
  return {
    id: 'ent-1',
    envioId: 'env-1',
    etapaId: 'gatilhos',
    etapaTitulo: 'Gatilhos',
    ordem: 1,
    estimativaPlano: 20,
    estimativaAgente: null,
    estimativaAgenteMotivo: null,
    estimativaAgenteEm: null,
    status: 'em_andamento',
    atrasada: false,
    motivo: null,
    boardItemId: null,
    auditada: null,
    corrigidoPor: null,
    corrigidoEm: null,
    iniciadaEm: AT,
    concluidaEm: null,
    tempoAtivoMs: 0,
    tempoCorridoMs: null,
    retrabalhoMs: 0,
    aviso80Em: null,
    aviso100Em: null,
    updatedAt: AT,
    ...over
  }
}

function envio(entregas: HandoffEntrega[], over: Partial<HandoffEnvio> = {}): HandoffEnvio {
  return {
    id: 'env-1',
    planSlug: 'plano-x',
    planTitulo: 'Plano X',
    projectId: 'p1',
    projectCwd: 'C:/proj',
    conversationId: 'conv-1',
    conversationTitle: 'Conversa',
    arquivo: '_handoff/x.md',
    ordem: 1,
    loteId: 'lote-1',
    conteudo: '',
    conteudoHash: 'h',
    status: 'em_execucao',
    motivo: null,
    estimativaTotal: 20,
    prazoTotal: 20,
    atrasado: false,
    tempoAtivoMs: 0,
    retrabalhoMs: 0,
    criadoEm: AT,
    enviadoEm: AT,
    iniciadoEm: AT,
    concluidoEm: null,
    updatedAt: AT,
    entregas,
    ...over
  }
}

/** O envio com a etapa em andamento a `ms` de tempo ativo (prazo de 20 min). */
const at = (ms: number, over: Partial<HandoffEntrega> = {}): HandoffEnvio => envio([entrega({ tempoAtivoMs: ms, ...over })])

/** Avança o tempo ativo em passos e devolve os marcos disparados, em ordem. */
function walk(steps: number[], fired: ScrumFired = new Map(), escala = 1): ScrumMarco[] {
  const out: ScrumMarco[] = []
  for (const ms of steps) {
    const due = dueScrumMark(at(ms), escala, fired)
    if (!due) continue
    out.push(due.marco)
    noteFired(fired, due.entrega.id, due.marco)
  }
  return out
}

describe('dueScrumMark — marcos de 150/200/300%', () => {
  it('abaixo de 150% nada dispara (nem no 100% nem no 149%)', () => {
    expect(walk([0, 10 * MIN, 20 * MIN, 21 * MIN, 29 * MIN, 30 * MIN - 1])).toEqual([])
  })

  it('150, 200 e 300% disparam uma vez cada por entrega', () => {
    const passos = [30 * MIN, 31 * MIN, 39 * MIN, 40 * MIN, 45 * MIN, 59 * MIN, 60 * MIN, 61 * MIN, 120 * MIN]
    expect(walk(passos)).toEqual([150, 200, 300])
  })

  it('o salto entrega só o maior marco e o de baixo fica disparado', () => {
    const fired: ScrumFired = new Map()
    const due = dueScrumMark(at(42 * MIN), 1, fired)
    expect(due?.marco).toBe(200)
    expect(due?.pulados).toEqual([150])
    noteFired(fired, 'ent-1', 200)
    expect(dueScrumMark(at(43 * MIN), 1, fired)).toBeNull()
    expect(walk([50 * MIN, 61 * MIN], fired)).toEqual([300])
  })

  it('do 120% direto ao 310%: só o de 300%', () => {
    const due = dueScrumMark(at(62 * MIN), 1, new Map())
    expect(due?.marco).toBe(300)
    expect(due?.pulados).toEqual([150, 200])
  })

  it('o retrabalho não conta: só o tempo ativo da entrega anda o marco', () => {
    expect(dueScrumMark(at(10 * MIN, { retrabalhoMs: 500 * MIN }), 1, new Map())).toBeNull()
    expect(dueScrumMark(envio([entrega({ tempoAtivoMs: 10 * MIN })], { retrabalhoMs: 500 * MIN }), 1, new Map())).toBeNull()
  })

  it('cada entrega tem os seus marcos: a próxima etapa começa do zero', () => {
    const fired: ScrumFired = new Map([['ent-1', 300]])
    const proxima = envio([
      entrega({ status: 'concluida', tempoAtivoMs: 70 * MIN }),
      entrega({ id: 'ent-2', etapaId: 'acoes', ordem: 2, estimativaPlano: 10, tempoAtivoMs: 16 * MIN, status: 'em_andamento' })
    ])
    const due = dueScrumMark(proxima, 1, fired)
    expect(due?.entrega.id).toBe('ent-2')
    expect(due?.marco).toBe(150)
  })

  it('sem prazo, envio concluído ou sem etapa contando: nada', () => {
    expect(dueScrumMark(at(500 * MIN, { estimativaPlano: null }), 1, new Map())).toBeNull()
    expect(dueScrumMark(at(500 * MIN, { estimativaPlano: 0 }), 1, new Map())).toBeNull()
    expect(dueScrumMark(envio([entrega({ tempoAtivoMs: 500 * MIN })], { status: 'concluida' }), 1, new Map())).toBeNull()
    expect(dueScrumMark(envio([entrega({ tempoAtivoMs: 500 * MIN, status: 'concluida' })]), 1, new Map())).toBeNull()
  })
})

describe('escala de dev (AGENT_CODE_SCRUM_ESCALA)', () => {
  it('com 0.05, o prazo de 20 min vira 1 min e os marcos vêm em 1,5/2/3 min', () => {
    expect(scrumPrazoMs(20, 0.05)).toBeCloseTo(MIN)
    expect(walk([MIN, 1.5 * MIN, 2 * MIN, 3 * MIN], new Map(), 0.05)).toEqual([150, 200, 300])
    expect(scrumEsperaMs(0.05)).toBeCloseTo(30_000)
  })

  it('inválida, fora de (0, 1], ausente ou no app empacotado vale 1', () => {
    expect(scrumEscala('0.05', false)).toBe(0.05)
    expect(scrumEscala(' 1 ', false)).toBe(1)
    for (const raw of [undefined, '', '  ', 'abc', '0', '-0.5', '1.5', 'NaN', 'Infinity']) expect(scrumEscala(raw, false)).toBe(1)
    expect(scrumEscala('0.05', true)).toBe(1)
    expect(scrumEsperaMs(1)).toBe(10 * MIN)
  })
})

describe('firedFromLog — o "já disparou" relido do diário', () => {
  const linha = (over: Partial<ScrumDecisao>): Pick<ScrumDecisao, 'entregaId' | 'marco'> => ({ entregaId: 'ent-1', marco: null, ...over })

  it('sobrevive a recriar o SM: o diário não deixa repetir marco', () => {
    const vivo: ScrumFired = new Map()
    expect(walk([31 * MIN, 41 * MIN], vivo)).toEqual([150, 200])
    // O que o SM gravou no diário (cobrou + entregue); um SM novo relê.
    const diario = [linha({ marco: 150 }), linha({ marco: 150 }), linha({ marco: 200 }), linha({ marco: 'travado' }), linha({ entregaId: null, marco: 300 })]
    const relido = firedFromLog(diario)
    expect(relido.get('ent-1')).toBe(200)
    expect(dueScrumMark(at(45 * MIN), 1, relido)).toBeNull()
    expect(walk([45 * MIN, 61 * MIN], relido)).toEqual([300])
  })

  it('linha sem marco numérico ou sem entrega é ignorada', () => {
    const relido = firedFromLog([linha({ marco: 'travado' }), linha({ entregaId: null, marco: 150 }), linha({ marco: 999 as ScrumMarco })])
    expect(relido.size).toBe(0)
  })

  it('noteFired só sobe', () => {
    const fired: ScrumFired = new Map()
    noteFired(fired, 'e', 200)
    noteFired(fired, 'e', 150)
    expect(fired.get('e')).toBe(200)
  })
})

describe('travadoDue — cobrança pendente sem chegar ao agente', () => {
  const espera = scrumEsperaMs(1)
  const desde = 1_000_000

  it('dispara com turno rodando e pendência de 10 min ou mais', () => {
    expect(travadoDue(desde, desde + espera, true, espera)).toBe(true)
    expect(travadoDue(desde, desde + espera + 5 * MIN, true, espera)).toBe(true)
  })

  it('não dispara antes dos 10 min, sem turno rodando ou sem pendência', () => {
    expect(travadoDue(desde, desde + espera - 1, true, espera)).toBe(false)
    expect(travadoDue(desde, desde + espera * 3, false, espera)).toBe(false)
    expect(travadoDue(null, desde + espera * 3, true, espera)).toBe(false)
  })

  it('com a escala de dev a espera encurta junto', () => {
    const curta = scrumEsperaMs(0.05)
    expect(travadoDue(desde, desde + 30_000, true, curta)).toBe(true)
    expect(travadoDue(desde, desde + 29_999, true, curta)).toBe(false)
  })
})
