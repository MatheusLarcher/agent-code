/** Dados de exemplo dos testes do painel do Scrum Master (só os testes importam). */
import type { ScrumDecisao, ScrumEnvioView, ScrumHistoryItem } from '@shared/scrumPanel'

export const NOW = new Date(2026, 9, 11, 15, 0).getTime()

/** ISO de hh:mm, `dayOffset` dias antes de NOW. */
export const at = (h: number, m: number, dayOffset = 0): string => new Date(2026, 9, 11 - dayOffset, h, m).toISOString()

export function envio(extra: Partial<ScrumEnvioView> = {}): ScrumEnvioView {
  return {
    envioId: 'e1',
    convId: 'c1',
    conversationTitle: 'Handoff autônomo',
    projectCwd: 'C:\\GitHub\\agent-code',
    estado: 'atrasado',
    vezes: 2.1,
    etapaN: 3,
    etapaTotal: 5,
    etapaTitulo: 'Ações',
    entregaId: 'g1',
    tempoAtivoMs: 84 * 60_000,
    prazoMin: 40,
    marcos: [150, 200],
    falas: [],
    semResposta: false,
    paradoMotivo: null,
    proximoNaFila: null,
    declaracao: null,
    ...extra
  }
}

export function decisao(extra: Partial<ScrumDecisao> = {}): ScrumDecisao {
  return {
    id: 'd1',
    at: at(12, 48),
    tipo: 'parou',
    convId: 'c2',
    conversationTitle: 'Funil de vendas',
    envioId: 'e2',
    entregaId: 'g2',
    etapaId: 'api',
    etapaN: 2,
    projectCwd: 'C:\\GitHub\\crm',
    marco: 300,
    veredito: 'parar',
    tipoDesvio: null,
    motivo: 'Três cobranças, nenhuma resposta',
    cobranca: null,
    tempoAtivoMs: 96 * 60_000,
    prazoMin: 30,
    declaradoMin: null,
    decorridoMs: null,
    rota: null,
    durationMs: null,
    ...extra
  }
}

export const histItem = (d: Partial<ScrumDecisao>, extra: Partial<ScrumHistoryItem> = {}): ScrumHistoryItem => ({ decisao: decisao(d), contestacao: null, resposta: null, ...extra })
