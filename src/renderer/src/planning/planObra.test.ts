import { describe, expect, it } from 'vitest'
import type { HandoffEnvioStatus } from '@shared/handoffTracking'
import { MIN, entrega, envio } from '../handoffTracking/handoffFixtures'
import { inicioText, minutosText, obraView, planEnviosOf } from './planObra'

const etapas = [
  { id: 'a', titulo: 'Banco', status: 'pendente' as const },
  { id: 'b', titulo: 'Tela', status: 'pendente' as const },
  { id: 'c', titulo: 'Testes', status: 'pendente' as const },
  { id: 'd', titulo: 'Aceite', status: 'pendente' as const }
]
const e = (etapaId: string, status: 'pendente' | 'em_andamento' | 'concluida' | 'incompleta', ordem = 1) =>
  entrega({ id: `hn-${etapaId}`, etapaId, etapaTitulo: etapas.find((x) => x.id === etapaId)?.titulo ?? etapaId, status, ordem })
const states = (v: ReturnType<typeof obraView>): string => v.bricks.map((b) => `${b.id}:${b.state}`).join(' ')

describe('a obra do plano (planObra)', () => {
  it('sem envio: na prancheta — os tijolos são as etapas na planta (a já concluída no roteiro, pronta)', () => {
    const v = obraView([], [{ ...etapas[0], status: 'concluida' }, ...etapas.slice(1)])
    expect(v.stage).toBe('prancheta')
    expect(states(v)).toBe('a:pronto b:planta c:planta d:planta')
    expect([v.mestre, v.inicio, v.etapa]).toEqual([null, null, null])
  })

  it('em obra: a etapa de agora (n de total), os tijolos por entrega, o mestre de obras, o tempo × prazo e o início', () => {
    const v = obraView(
      [
        envio({
          status: 'em_execucao',
          conversationId: 'impl',
          conversationTitle: 'Implementação: Checkout',
          tempoAtivoMs: 40 * MIN,
          prazoTotal: 50,
          enviadoEm: '2026-10-05T12:00:00.000Z',
          entregas: [e('a', 'concluida', 1), e('b', 'em_andamento', 2), e('c', 'pendente', 3)]
        })
      ],
      etapas
    )
    expect(v.stage).toBe('obra')
    expect(v.headline).toBe('Mão na massa: Tela')
    expect(v.etapa).toEqual({ n: 2, total: 4, titulo: 'Tela' })
    expect(states(v)).toBe('a:pronto b:massa c:fila d:planta')
    expect(v.mestre).toEqual({ conversationId: 'impl', title: 'Implementação: Checkout' })
    expect(v.tempo).toEqual({ ativoMs: 40 * MIN, prazoMin: 50, level: 'alerta' })
    expect(v.inicio).toBe('2026-10-05T12:00:00.000Z')
    expect(v.detail).toBeNull()
  })

  it('o estágio vem do lote mais recente, do mais grave ao mais quieto: precisa de você > em obra; lote antigo que falhou não manda mais', () => {
    const lote = (id: string, status: HandoffEnvioStatus, over = {}) =>
      envio({ id, loteId: 'hl-2', criadoEm: '2026-10-05T13:00:00.000Z', status, ...over })
    const velho = envio({ id: 'v', loteId: 'hl-1', status: 'falhou', motivo: 'quebrou', criadoEm: '2026-10-05T10:00:00.000Z' })
    expect(obraView([velho, lote('x', 'em_execucao')], etapas).stage).toBe('obra')
    const vistoria = obraView([velho, lote('x', 'em_execucao'), lote('y', 'aguardando_voce', { motivo: 'pergunta aberta' })], etapas)
    expect([vistoria.stage, vistoria.detail]).toEqual(['vistoria', 'pergunta aberta'])
    const canteiro = obraView([lote('x', 'na_fila')], etapas)
    expect([canteiro.stage, canteiro.etapa]).toEqual(['canteiro', null])
    const parada = obraView([lote('x', 'parada', { motivo: 'sem turno há 20 min', entregas: [e('c', 'em_andamento')] })], etapas)
    expect([parada.stage, parada.headline, parada.detail]).toEqual(['parada', 'A obra parou em Testes.', 'sem turno há 20 min'])
    expect(obraView([lote('x', 'falhou', { motivo: 'erro' })], etapas).stage).toBe('embargada')
    expect(obraView([lote('x', 'incompleta')], etapas).stage).toBe('acabamento')
  })

  it('tudo pronto é habite-se; enviado pronto com etapa ainda na planta é fase entregue; etapa trincada de lote anterior é acabamento', () => {
    const tudo = ['a', 'b', 'c', 'd'].map((id, i) => e(id, 'concluida', i + 1))
    const habitese = obraView([envio({ status: 'concluida', entregas: tudo })], etapas)
    expect([habitese.stage, habitese.etapa]).toEqual(['habitese', null])
    expect(habitese.headline).toBe('Obra entregue — chave na mão. 4 etapas prontas.')
    const fase = obraView([envio({ status: 'concluida', entregas: tudo.slice(0, 2) })], etapas)
    expect([fase.stage, fase.headline]).toEqual(['fase', 'Fase entregue: 2 de 4 etapas prontas — o resto do plano ainda está na planta.'])
    const trinca = obraView(
      [
        envio({ id: 'v', loteId: 'hl-1', status: 'incompleta', criadoEm: '2026-10-05T10:00:00.000Z', entregas: [e('a', 'incompleta')] }),
        envio({ id: 'n', loteId: 'hl-2', status: 'concluida', criadoEm: '2026-10-05T11:00:00.000Z', entregas: [e('b', 'concluida'), e('c', 'concluida'), e('d', 'concluida')] })
      ],
      etapas
    )
    expect([trinca.stage, states(trinca)]).toEqual(['acabamento', 'a:trinca b:pronto c:pronto d:pronto'])
  })

  it('reenvio refaz a etapa (vale a entrega mais nova); etapa enviada que saiu do roteiro continua no fim; tempo e prazo somam os envios', () => {
    const v = obraView(
      [
        envio({ id: 'v', loteId: 'hl-1', status: 'incompleta', criadoEm: '2026-10-05T10:00:00.000Z', enviadoEm: '2026-10-05T10:00:00.000Z', tempoAtivoMs: 10 * MIN, prazoTotal: 20, entregas: [e('a', 'incompleta')] }),
        envio({ id: 'n', loteId: 'hl-2', status: 'em_execucao', enviadoEm: '2026-10-05T11:00:00.000Z', criadoEm: '2026-10-05T11:00:00.000Z', tempoAtivoMs: 5 * MIN, prazoTotal: null, estimativaTotal: 15, entregas: [e('a', 'concluida'), entrega({ etapaId: 'z', etapaTitulo: 'Extra', status: 'em_andamento' })] })
      ],
      etapas
    )
    expect(states(v)).toBe('a:pronto b:planta c:planta d:planta z:massa')
    expect(v.etapa).toEqual({ n: null, total: 4, titulo: 'Extra' })
    expect(v.tempo).toEqual({ ativoMs: 15 * MIN, prazoMin: 35, level: 'ok' })
    expect(v.inicio).toBe('2026-10-05T10:00:00.000Z')
  })

  it('os envios do plano: o mesmo slug no mesmo projeto, caminho sem caixa nem barras', () => {
    const list = [
      envio({ id: '1', planSlug: 'checkout', projectCwd: 'C:\\Proj\\App\\' }),
      envio({ id: '2', planSlug: 'login', projectCwd: 'c:/proj/app' }),
      envio({ id: '3', planSlug: 'checkout', projectCwd: 'D:/outro' })
    ]
    expect(planEnviosOf(list, 'c:/proj/app', 'checkout').map((x) => x.id)).toEqual(['1'])
  })

  it('textos: minutos de obra e o início relativo a hoje', () => {
    expect([minutosText(0), minutosText(45), minutosText(60), minutosText(125)]).toEqual(['0 min', '45 min', '1 h', '2 h 05 min'])
    const now = new Date(2026, 9, 5, 22, 0).getTime()
    expect(inicioText(new Date(2026, 9, 5, 20, 51).toISOString(), now)).toBe('hoje, 20:51')
    expect(inicioText(new Date(2026, 9, 4, 18, 2).toISOString(), now)).toBe('ontem, 18:02')
    expect(inicioText(new Date(2026, 9, 3, 14, 0).toISOString(), now)).toBe('03/10, 14:00')
  })
})
