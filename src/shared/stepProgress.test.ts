import { describe, expect, it } from 'vitest'
import type { HandoffEntrega, HandoffEnvio } from './handoffTracking'
import { boardItemStatus, type BoardItem, type BoardItemStatus } from './ipc'
import { ENTREGA_STATUS_LABEL, planEnvioAtual, planEnviosOf, planProgress, roteiroProgress, stepLabel, taskCounts } from './stepProgress'

const AT = '2026-10-05T12:00:00.000Z'
const min = (m: number): string => new Date(Date.UTC(2026, 9, 5, 12, m)).toISOString()

function entrega(etapaId: string, status: HandoffEntrega['status'] = 'pendente', ordem = 1, etapaTitulo = etapaId.toUpperCase()): HandoffEntrega {
  return {
    id: `hn-${etapaId}-${ordem}`, envioId: 'he', etapaId, etapaTitulo, ordem, estimativaPlano: null, estimativaAgente: null,
    estimativaAgenteMotivo: null, estimativaAgenteEm: null, status, atrasada: false, motivo: null, boardItemId: null, auditada: null,
    corrigidoPor: null, corrigidoEm: null, iniciadaEm: null, concluidaEm: null, tempoAtivoMs: 0, tempoCorridoMs: null, retrabalhoMs: 0,
    aviso80Em: null, aviso100Em: null, updatedAt: AT
  }
}

function envio(over: Partial<HandoffEnvio> = {}): HandoffEnvio {
  return {
    id: 'he', planSlug: 'checkout', planTitulo: 'Checkout', projectId: 'p', projectCwd: 'C:/proj', conversationId: 'impl',
    conversationTitle: 'Implementação', arquivo: 'p1.md', ordem: 1, loteId: 'hl-1', conteudo: '', conteudoHash: '', status: 'em_execucao',
    motivo: null, estimativaTotal: null, prazoTotal: null, atrasado: false, tempoAtivoMs: 0, retrabalhoMs: 0, criadoEm: AT, enviadoEm: AT,
    iniciadoEm: AT, concluidoEm: null, updatedAt: AT, entregas: [], ...over
  }
}

const roteiro = [
  { id: 'a', titulo: 'Banco' },
  { id: 'b', titulo: 'Tela' },
  { id: 'c', titulo: 'Testes' },
  { id: 'd', titulo: 'Aceite' }
]
const states = (p: ReturnType<typeof planProgress>): string => p.steps.map((s) => `${s.n}.${s.id}:${s.state}`).join(' ')

describe('os envios do plano (planEnviosOf)', () => {
  it('o mesmo slug no mesmo projeto, caminho comparado sem caixa nem barras', () => {
    const list = [
      envio({ id: '1', planSlug: 'checkout', projectCwd: 'C:\\Proj\\App\\' }),
      envio({ id: '2', planSlug: 'login', projectCwd: 'c:/proj/app' }),
      envio({ id: '3', planSlug: 'checkout', projectCwd: 'D:/outro' })
    ]
    expect(planEnviosOf(list, 'c:/proj/app', 'checkout').map((x) => x.id)).toEqual(['1'])
  })
})

describe('o envio de agora do plano (planEnvioAtual)', () => {
  it('sem envios: null', () => {
    expect(planEnvioAtual([])).toBeNull()
  })

  it('o lote mais novo (por criadoEm) manda: um lote antigo que falhou não conta', () => {
    const velho = envio({ id: 'v', loteId: 'hl-1', status: 'falhou', criadoEm: min(0) })
    const novo = envio({ id: 'n', loteId: 'hl-2', status: 'enviado', criadoEm: min(10) })
    expect(planEnvioAtual([velho, novo])?.id).toBe('n')
  })

  it('dentro do lote, o status mais vivo/grave: aguardando você > em execução > parada > falhou > incompleta > enviado > na fila', () => {
    const order = ['aguardando_voce', 'em_execucao', 'parada', 'falhou', 'incompleta', 'enviado', 'na_fila'] as const
    for (let i = 0; i < order.length; i++) {
      const lote = order.slice(i).reverse().map((status, k) => envio({ id: status, status, ordem: k + 1, loteId: 'hl-2', criadoEm: min(5) }))
      expect(planEnvioAtual([...lote, envio({ id: 'concl', status: 'concluida', loteId: 'hl-2', criadoEm: min(5) })])?.id).toBe(order[i])
    }
  })

  it('lote todo concluído: o último que saiu (currentEnvio); nada saiu, o mais novo', () => {
    const a = envio({ id: 'a', status: 'concluida', ordem: 1, enviadoEm: min(1) })
    const b = envio({ id: 'b', status: 'concluida', ordem: 2, enviadoEm: min(3) })
    expect(planEnvioAtual([b, a])?.id).toBe('b')
  })
})

describe('o progresso das etapas (planProgress)', () => {
  it('com roteiro: a ordem do roteiro; etapa nunca enviada fica na planta (mesmo com o status "concluida" do roteiro, que é especificada)', () => {
    const especificadas = roteiro.map((e) => ({ ...e, status: 'concluida' as const }))
    const p = planProgress([envio({ entregas: [entrega('b', 'em_andamento', 1)] })], especificadas)
    expect(states(p)).toBe('1.a:planta 2.b:massa 3.c:planta 4.d:planta')
    expect([p.total, p.prontas, p.incompletas]).toEqual([4, 0, 0])
    expect(p.steps.map((s) => s.titulo)).toEqual(['Banco', 'Tela', 'Testes', 'Aceite'])
    expect(p.steps[0].entrega).toBeNull()
  })

  it('sem envios: tudo na planta, sem envio nem etapa de agora', () => {
    const p = planProgress([], roteiro)
    expect(states(p)).toBe('1.a:planta 2.b:planta 3.c:planta 4.d:planta')
    expect([p.envioAtual, p.atual]).toEqual([null, null])
  })

  it('etapa enviada que não está (mais) no roteiro entra no fim, numerada', () => {
    const p = planProgress([envio({ entregas: [entrega('a', 'concluida', 1), entrega('z', 'em_andamento', 2, 'Extra')] })], roteiro)
    expect(states(p)).toBe('1.a:pronto 2.b:planta 3.c:planta 4.d:planta 5.z:massa')
    expect(p.steps[4].titulo).toBe('Extra')
    expect([p.total, p.prontas]).toEqual([5, 1])
    expect(p.atual?.n).toBe(5)
  })

  it('sem roteiro: a união das entregas por (envio.criadoEm — o registro do lote —, envio.ordem, entrega.ordem)', () => {
    const p = planProgress([
      envio({ id: '2', ordem: 2, enviadoEm: min(5), entregas: [entrega('y', 'pendente', 2), entrega('x', 'pendente', 1)] }),
      envio({ id: '1', ordem: 1, enviadoEm: min(5), entregas: [entrega('w', 'concluida', 1)] }),
      envio({ id: '0', ordem: 9, enviadoEm: null, criadoEm: min(1), status: 'na_fila', entregas: [entrega('v', 'pendente', 1)] })
    ])
    // O lote registrado depois (min 1) vem depois, mesmo sem ter saído.
    expect(states(p)).toBe('1.w:pronto 2.x:fila 3.y:fila 4.v:fila')
    expect(p.steps.map((s) => s.titulo)).toEqual(['W', 'X', 'Y', 'V'])
  })

  it('sem roteiro: o prompt 2 ainda na fila não passa à frente do prompt 1 já enviado (a saída não reordena o lote)', () => {
    // O lote registrado no min 0; o prompt 1 saiu no min 5, o 2 espera na fila.
    const p1 = envio({ id: 'p1', ordem: 1, criadoEm: min(0), enviadoEm: min(5), entregas: [entrega('a', 'em_andamento', 1), entrega('b', 'pendente', 2)] })
    const p2 = envio({ id: 'p2', ordem: 2, criadoEm: min(0), enviadoEm: null, status: 'na_fila', entregas: [entrega('c', 'pendente', 1), entrega('d', 'pendente', 2)] })
    const p = planProgress([p2, p1])
    expect(states(p)).toBe('1.a:massa 2.b:fila 3.c:fila 4.d:fila')
    expect(stepLabel(p, p1)).toBe('Etapa 1 de 4: A')
    // Um reenvio (lote novo) não muda a posição das etapas que já tinham saído.
    const reenvio = envio({ id: 'r1', loteId: 'hl-2', ordem: 1, criadoEm: min(9), enviadoEm: null, status: 'na_fila', entregas: [entrega('a', 'pendente', 1), entrega('e', 'pendente', 2)] })
    expect(states(planProgress([reenvio, p2, p1]))).toBe('1.a:fila 2.b:fila 3.c:fila 4.d:fila 5.e:fila')
  })

  it('a entrega mais recente de cada etapa vence (o reenvio refaz a etapa), sem mudar a posição dela', () => {
    const velho = envio({ id: 'v', loteId: 'hl-1', status: 'incompleta', criadoEm: min(0), enviadoEm: min(0), entregas: [entrega('a', 'incompleta'), entrega('b', 'concluida', 2)] })
    const novo = envio({ id: 'n', loteId: 'hl-2', status: 'em_execucao', criadoEm: min(9), enviadoEm: min(9), entregas: [entrega('a', 'concluida')] })
    const p = planProgress([novo, velho])
    expect(states(p)).toBe('1.a:pronto 2.b:pronto')
    expect(p.steps[0].entrega?.status).toBe('concluida')
    const trinca = planProgress([velho])
    expect([trinca.prontas, trinca.incompletas]).toEqual([1, 1])
  })

  it('a etapa de agora é a de currentEntrega do envio de agora', () => {
    const p = planProgress(
      [
        envio({ id: 'x', status: 'em_execucao', entregas: [entrega('a', 'concluida', 1), entrega('b', 'concluida', 2), entrega('c', 'pendente', 3)] }),
        envio({ id: 'y', status: 'aguardando_voce', ordem: 2, entregas: [entrega('d', 'em_andamento', 1)] })
      ],
      roteiro
    )
    expect(p.envioAtual?.id).toBe('y')
    expect([p.atual?.id, p.atual?.n, p.total]).toEqual(['d', 4, 4])
  })
})

describe('o rótulo único (stepLabel)', () => {
  it('"Etapa N de M: título" da etapa de agora', () => {
    const p = planProgress([envio({ entregas: [entrega('a', 'concluida', 1), entrega('b', 'em_andamento', 2)] })], roteiro)
    expect(stepLabel(p)).toBe('Etapa 2 de 4: Tela')
  })

  it('sem etapa de agora (nada enviado, fase entregue): a primeira que não está pronta', () => {
    expect(stepLabel(planProgress([], roteiro))).toBe('Etapa 1 de 4: Banco')
    const fase = planProgress([envio({ status: 'concluida', entregas: [entrega('a', 'concluida', 1), entrega('b', 'concluida', 2)] })], roteiro)
    expect(stepLabel(fase)).toBe('Etapa 3 de 4: Testes')
  })

  it('"Etapas concluídas" com tudo pronto; "Sem etapas" sem nenhuma', () => {
    const tudo = planProgress([envio({ status: 'concluida', entregas: roteiro.map((e, i) => entrega(e.id, 'concluida', i + 1)) })], roteiro)
    expect(stepLabel(tudo)).toBe('Etapas concluídas')
    expect(stepLabel(planProgress([], []))).toBe('Sem etapas')
    expect(stepLabel(planProgress([]))).toBe('Sem etapas')
  })

  it('de UM envio (plano mandado em partes): a etapa de agora dele, numerada pela posição no PLANO', () => {
    const parte1 = envio({ id: 'p1', status: 'concluida', enviadoEm: min(1), entregas: [entrega('a', 'concluida', 1), entrega('b', 'concluida', 2)] })
    const parte2 = envio({ id: 'p2', ordem: 2, enviadoEm: min(5), entregas: [entrega('c', 'em_andamento', 1, 'Testes'), entrega('d', 'pendente', 2, 'Aceite')] })
    const p = planProgress([parte1, parte2], roteiro)
    // A 1ª etapa da parte 2 é a 3ª do plano (não "1 de 2" do prompt).
    expect(stepLabel(p, parte2)).toBe('Etapa 3 de 4: Testes')
    // Sem roteiro: a mesma posição pela união das entregas.
    expect(stepLabel(planProgress([parte1, parte2]), parte2)).toBe('Etapa 3 de 4: Testes')
    // O envio com tudo concluído: "Etapas concluídas" (dele), mesmo com o plano andando; sem entregas, "Sem etapas".
    expect(stepLabel(p, parte1)).toBe('Etapas concluídas')
    expect(stepLabel(p, envio({ id: 'vazio', entregas: [] }))).toBe('Sem etapas')
  })
})

describe('os rótulos do status da entrega (ENTREGA_STATUS_LABEL)', () => {
  it('um rótulo por status, o mesmo no topo do chat e na Implantação', () => {
    expect(ENTREGA_STATUS_LABEL).toEqual({ pendente: 'pendente', em_andamento: 'em andamento', concluida: 'concluída', incompleta: 'incompleta' })
  })
})

describe('a contagem única de tarefas (taskCounts)', () => {
  it('a fazer / em andamento / concluídas / total pelo status (outro status conta como a fazer)', () => {
    const items = [{ status: 'pending' }, { status: 'in_progress' }, { status: 'completed' }, { status: 'completed' }, { status: 'blocked' }]
    expect(taskCounts(items)).toEqual({ pending: 2, inProgress: 1, done: 2, total: 5 })
    expect(taskCounts([])).toEqual({ pending: 0, inProgress: 0, done: 0, total: 0 })
  })

  it('com o status efetivo do chamador (o do PO por cima do da fonte, no Quadro)', () => {
    const cards = [
      { sourceStatus: 'in_progress', poStatus: 'completed' },
      { sourceStatus: 'pending', poStatus: null },
      { sourceStatus: 'completed', poStatus: 'pending' }
    ]
    expect(taskCounts(cards, (c) => c.poStatus ?? c.sourceStatus)).toEqual({ pending: 2, inProgress: 0, done: 1, total: 3 })
  })

  it('o cabeçalho de um grupo da Lista do Quadro ("N tarefas, M concluídas") conta pelo boardItemStatus', () => {
    const card = (sourceStatus: BoardItemStatus, poStatus: BoardItemStatus | null): BoardItem => ({ sourceStatus, poStatus }) as BoardItem
    // Só pela fonte daria 2 concluídas; só pelo PO, também 2. Pelo status efetivo (PO por cima da fonte), 3.
    const group = [card('in_progress', 'completed'), card('completed', 'pending'), card('pending', 'completed'), card('completed', null), card('pending', null)]
    const { done, total } = taskCounts(group, boardItemStatus)
    expect({ done, total }).toEqual({ done: 3, total: 5 })
  })
})

describe('o progresso da especificação (roteiroProgress)', () => {
  it('conta as etapas que o planejamento marcou como concluídas (especificadas)', () => {
    expect(roteiroProgress([{ status: 'concluida' }, { status: 'em_andamento' }, { status: 'pendente' }, { status: 'concluida' }])).toEqual({ feitas: 2, total: 4 })
    expect(roteiroProgress([])).toEqual({ feitas: 0, total: 0 })
  })
})
