import { describe, expect, it } from 'vitest'
import type { HandoffEntrega, HandoffEnvio } from '../../shared/handoffTracking'
import type { ScrumDecisao } from '../../shared/scrumPanel'
import { createScrumFeed } from './scrumFeed'
import { avisouVoce, buildScrumPanel, contestedCount, scrumHistory, type ScrumPanelInput } from './scrumPanelView'
import type { ScrumDeclaracao } from './scrumTypes'

const MIN = 60_000
const NOW = Date.parse('2026-10-11T15:00:00.000Z')
const AT = '2026-10-11T12:00:00.000Z'

function entrega(over: Partial<HandoffEntrega> = {}): HandoffEntrega {
  return {
    id: 'ent-1',
    envioId: 'env-1',
    etapaId: 'visual',
    etapaTitulo: 'Escritório 3D',
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
    tempoAtivoMs: 10 * MIN,
    tempoCorridoMs: null,
    retrabalhoMs: 0,
    aviso80Em: null,
    aviso100Em: null,
    updatedAt: AT,
    ...over
  }
}

function envio(over: Partial<HandoffEnvio> = {}, ent: Partial<HandoffEntrega> = {}): HandoffEnvio {
  const id = over.id ?? 'env-1'
  return {
    id,
    planSlug: 'plano-x',
    planTitulo: 'Plano X',
    projectId: 'p1',
    projectCwd: 'C:/GitHub/agent-code',
    conversationId: `conv-${id}`,
    conversationTitle: `Conversa ${id}`,
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
    entregas: [entrega({ envioId: id, id: `ent-${id}`, ...ent })],
    ...over
  }
}

let seq = 0
function d(over: Partial<ScrumDecisao> = {}): ScrumDecisao {
  seq += 1
  return {
    id: `d-${seq}`,
    at: AT,
    tipo: 'cobrou',
    convId: 'conv-env-1',
    conversationTitle: 'Conversa env-1',
    envioId: 'env-1',
    entregaId: 'ent-env-1',
    etapaId: 'visual',
    etapaN: 4,
    projectCwd: 'C:/GitHub/agent-code',
    marco: 150,
    veredito: 'justificado',
    tipoDesvio: null,
    motivo: 'subestimada',
    cobranca: '⏱ Etapa 4: feche a etapa',
    tempoAtivoMs: 30 * MIN,
    prazoMin: 20,
    declaradoMin: null,
    decorridoMs: null,
    rota: 'claude-sonnet-5-5',
    durationMs: 10,
    ...over
  }
}

function input(over: Partial<ScrumPanelInput> = {}): ScrumPanelInput {
  return {
    envios: [],
    log: [],
    declaracoes: [],
    now: NOW,
    enabled: true,
    podeParar: false,
    logFile: 'C:/u/scrum-decisions.log',
    places: new Map(),
    queued: new Map(),
    ...over
  }
}

describe('buildScrumPanel — a aba Agora', () => {
  it('estado vazio: sem envios, tiles zerados', () => {
    const s = buildScrumPanel(input())
    expect(s.envios).toEqual([])
    expect(s.tiles).toEqual({ acompanhados: 0, cobrancasHoje: 0, parados: 0 })
    expect(s.contestados).toBe(0)
    expect(s.logFile).toBe('C:/u/scrum-decisions.log')
  })

  it('os três estados: no prazo, atrasado (N× do prazo) e parado pelo SM — parados primeiro', () => {
    const s = buildScrumPanel(
      input({
        envios: [
          envio({ id: 'a' }, { tempoAtivoMs: 10 * MIN }),
          envio({ id: 'b' }, { tempoAtivoMs: 31 * MIN }),
          envio({ id: 'c', status: 'parada', motivo: 'Scrum Master: laço de teste sem fim' }, { tempoAtivoMs: 62 * MIN }),
          // Parada que não é do SM (tirada da fila): fora do painel.
          envio({ id: 'd', status: 'parada', motivo: 'Tirado da fila' }),
          // Sem prazo: o SM não acompanha.
          envio({ id: 'e' }, { estimativaPlano: null })
        ],
        places: new Map([['b', { n: 4, total: 5 }]])
      })
    )
    expect(s.envios.map((e) => [e.envioId, e.estado])).toEqual([
      ['c', 'parado'],
      ['b', 'atrasado'],
      ['a', 'no-prazo']
    ])
    const b = s.envios.find((e) => e.envioId === 'b')!
    expect(b.vezes).toBeCloseTo(1.55, 2)
    expect([b.etapaN, b.etapaTotal, b.etapaTitulo]).toEqual([4, 5, 'Escritório 3D'])
    const c = s.envios.find((e) => e.envioId === 'c')!
    expect(c.paradoMotivo).toBe('laço de teste sem fim')
    expect(s.tiles).toEqual({ acompanhados: 3, cobrancasHoje: 0, parados: 1 })
  })

  it('a linha do projeto: caminho e título da conversa vêm do envio', () => {
    const s = buildScrumPanel(input({ envios: [envio({ id: 'a', projectCwd: 'D:/proj/app', conversationTitle: '' })] }))
    expect(s.envios[0]).toMatchObject({ projectCwd: 'D:/proj/app', conversationTitle: 'Conversa', convId: 'conv-a' })
  })

  it('falas SM ↔ agente, marcos disparados e "ainda sem resposta"', () => {
    const cobrou = d({ at: '2026-10-11T12:10:00.000Z', marco: 150 })
    const resposta = d({ at: '2026-10-11T12:11:00.000Z', tipo: 'resposta', refId: cobrou.id, texto: 'Fechando o teste agora.', veredito: null, cobranca: null })
    const cobrou2 = d({ at: '2026-10-11T12:20:00.000Z', marco: 200, cobranca: '⏱ Etapa 4: 2× do prazo' })
    const outra = d({ envioId: 'outro', entregaId: 'x' })
    const s = buildScrumPanel(input({ envios: [envio({}, { tempoAtivoMs: 41 * MIN })], log: [cobrou, resposta, cobrou2, outra] }))
    const v = s.envios[0]
    expect(v.marcos).toEqual([150, 200])
    expect(v.falas.map((f) => [f.quem, f.texto, f.avisouVoce])).toEqual([
      ['sm', '⏱ Etapa 4: feche a etapa', false],
      ['agente', 'Fechando o teste agora.', false],
      ['sm', '⏱ Etapa 4: 2× do prazo', true]
    ])
    expect(v.semResposta).toBe(true)
    // Cobranças de hoje: cobrou + falha (a de outro envio também conta).
    expect(s.tiles.cobrancasHoje).toBe(3)
  })

  it('a declaração acima do teto sem decisão aparece no cartão; a decidida, não', () => {
    const decl: ScrumDeclaracao = { envioId: 'env-1', entregaId: 'ent-env-1', pedidoMin: 90, validoMin: 60, motivo: 'build longo', at: NOW, acimaDoTeto: true }
    expect(buildScrumPanel(input({ envios: [envio()], declaracoes: [decl] })).envios[0].declaracao).toEqual({
      entregaId: 'ent-env-1',
      pedidoMin: 90,
      validoMin: 60,
      motivo: 'build longo'
    })
    expect(buildScrumPanel(input({ envios: [envio()], declaracoes: [{ ...decl, decidida: 'aprovou' }] })).envios[0].declaracao).toBeNull()
  })

  it('o próximo prompt na fila da conversa ("Tirar da fila")', () => {
    const s = buildScrumPanel(input({ envios: [envio()], queued: new Map([['conv-env-1', 'env-2']]) }))
    expect(s.envios[0].proximoNaFila).toBe('env-2')
  })
})

describe('scrumHistory — a aba Histórico', () => {
  const now = Date.parse('2026-10-20T12:00:00.000Z')
  const corte = d({ id: 'corte', tipo: 'parou', at: '2026-10-20T10:00:00.000Z', marco: 300, motivo: 'laço', projectCwd: 'C:/proj/loja' })
  const interrompeu = d({ id: 'int', tipo: 'interrompeu', at: '2026-10-19T10:00:00.000Z', marco: 'travado' })
  const cobrou150 = d({ id: 'c150', tipo: 'cobrou', at: '2026-10-18T10:00:00.000Z', marco: 150, conversationTitle: 'Checkout' })
  const falha200 = d({ id: 'f200', tipo: 'falha', at: '2026-10-01T10:00:00.000Z', marco: 200 })
  const avisou = d({ id: 'av', tipo: 'avisou', at: '2026-09-01T10:00:00.000Z' })
  const seguiu = d({ id: 'seg', tipo: 'deixou-seguir', at: '2026-10-20T09:00:00.000Z' })
  const entregue = d({ id: 'ent', tipo: 'entregue', at: '2026-10-18T10:01:00.000Z' })
  const contest = d({ id: 'k', tipo: 'contestado', at: '2026-10-20T11:00:00.000Z', refId: 'corte', texto: 'ele estava quase terminando' })
  const resp = d({ id: 'r', tipo: 'resposta', at: '2026-10-18T10:02:00.000Z', refId: 'c150', texto: 'ok, fechando' })
  const log = [avisou, falha200, cobrou150, entregue, resp, interrompeu, seguiu, corte, contest]

  it('do mais novo para o mais antigo; só as decisões (entregue/resposta/contestado se anexam)', () => {
    const r = scrumHistory(log, { filtro: 'tudo', periodo: 'tudo' }, now)
    expect(r.items.map((i) => i.decisao.id)).toEqual(['corte', 'seg', 'int', 'c150', 'f200', 'av'])
    expect(r.total).toBe(6)
    expect(r.items[0].contestacao).toEqual({ frase: 'ele estava quase terminando', at: '2026-10-20T11:00:00.000Z' })
    expect(r.items.find((i) => i.decisao.id === 'c150')!.resposta).toBe('ok, fechando')
  })

  it('os filtros: cortes, contestados, cobranças e avisos a você', () => {
    const ids = (filtro: Parameters<typeof scrumHistory>[1]['filtro']): string[] =>
      scrumHistory(log, { filtro, periodo: 'tudo' }, now).items.map((i) => i.decisao.id)
    expect(ids('cortes')).toEqual(['corte', 'int'])
    expect(ids('contestados')).toEqual(['corte'])
    expect(ids('cobrancas')).toEqual(['c150', 'f200'])
    expect(ids('avisos')).toEqual(['corte', 'int', 'f200', 'av'])
  })

  it('o período (7d/30d) e a busca por projeto ou conversa', () => {
    expect(scrumHistory(log, { filtro: 'tudo', periodo: '7d' }, now).items.map((i) => i.decisao.id)).toEqual(['corte', 'seg', 'int', 'c150'])
    expect(scrumHistory(log, { filtro: 'tudo', periodo: '30d' }, now).items.map((i) => i.decisao.id)).toEqual(['corte', 'seg', 'int', 'c150', 'f200'])
    expect(scrumHistory(log, { filtro: 'tudo', periodo: 'tudo', busca: 'LOJA' }, now).items.map((i) => i.decisao.id)).toEqual(['corte'])
    expect(scrumHistory(log, { filtro: 'tudo', periodo: 'tudo', busca: 'checkout' }, now).items.map((i) => i.decisao.id)).toEqual(['c150'])
  })

  it('o selo de contestados conta decisões, não linhas', () => {
    expect(contestedCount([...log, d({ tipo: 'contestado', refId: 'corte', texto: 'de novo' })])).toBe(1)
  })

  it('avisou você: parada, corte, aviso e cobrança a partir de 200%', () => {
    expect([corte, interrompeu, avisou, falha200].every(avisouVoce)).toBe(true)
    expect([cobrou150, seguiu, entregue].some(avisouVoce)).toBe(false)
  })
})

describe('scrumFeed — o diário com aviso e a resposta do agente', () => {
  it('grava, avisa a tela e liga o primeiro texto do agente à cobrança entregue', () => {
    const written: ScrumDecisao[] = []
    const emitted: ScrumDecisao[] = []
    let n = 0
    const feed = createScrumFeed({ write: (x) => written.push(x), emit: (x) => emitted.push(x), now: () => Date.parse(AT) + 60_000, uuid: () => `u-${++n}` })
    const cobrou = d({ id: 'cob', convId: 'c1' })
    feed.agentText('c1', 'antes da entrega não conta')
    feed.log(cobrou)
    feed.log(d({ id: 'ent', tipo: 'entregue', convId: 'c1', cobranca: cobrou.cobranca }))
    feed.agentText('c1', '   ')
    feed.agentText('c1', 'Entendi, fechando a etapa.')
    feed.agentText('c1', 'segundo texto não conta')
    expect(written.map((x) => x.tipo)).toEqual(['cobrou', 'entregue', 'resposta'])
    expect(emitted.map((x) => x.id)).toEqual(written.map((x) => x.id))
    const r = written[2]
    expect(r).toMatchObject({ refId: 'cob', texto: 'Entendi, fechando a etapa.', envioId: 'env-1', decorridoMs: 60_000, veredito: null, cobranca: null })
  })

  it('o corte (interrompeu) também espera a resposta; a parada limpa a espera', () => {
    const written: ScrumDecisao[] = []
    const feed = createScrumFeed({ write: (x) => written.push(x), emit: () => undefined })
    feed.log(d({ id: 'int', tipo: 'interrompeu', convId: 'c2' }))
    feed.agentText('c2', 'voltei')
    feed.log(d({ id: 'int2', tipo: 'interrompeu', convId: 'c3' }))
    feed.log(d({ id: 'par', tipo: 'parou', convId: 'c3' }))
    feed.agentText('c3', 'não deve gravar')
    expect(written.filter((x) => x.tipo === 'resposta').map((x) => x.refId)).toEqual(['int'])
  })

  it('a escrita ou a tela falhando não derrubam o SM', () => {
    const feed = createScrumFeed({
      write: () => {
        throw new Error('disco')
      },
      emit: () => {
        throw new Error('janela fechada')
      }
    })
    expect(() => feed.log(d())).not.toThrow()
  })
})
