import type { HandoffEntrega, HandoffEnvio } from '@shared/handoffTracking'

/**
 * Envios e entregas de handoff para os testes do indicador de prazo. Só teste
 * importa daqui; valores neutros, o teste muda o que importa.
 */

export const MIN = 60_000
const AT = '2026-10-05T12:00:00.000Z'

export function entrega(over: Partial<HandoffEntrega> = {}): HandoffEntrega {
  const etapaId = over.etapaId ?? 'registro-no-banco'
  return {
    id: `hn-${etapaId}`,
    envioId: 'he-1',
    etapaId,
    etapaTitulo: 'Registro no banco',
    ordem: 1,
    estimativaPlano: 30,
    estimativaAgente: null,
    estimativaAgenteMotivo: null,
    estimativaAgenteEm: null,
    status: 'pendente',
    atrasada: false,
    motivo: null,
    boardItemId: null,
    auditada: null,
    corrigidoPor: null,
    corrigidoEm: null,
    iniciadaEm: null,
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

export function envio(over: Partial<HandoffEnvio> = {}): HandoffEnvio {
  return {
    id: 'he-1',
    planSlug: 'checkout',
    planTitulo: 'Checkout com Pix',
    projectId: 'proj-1',
    projectCwd: 'C:/proj',
    conversationId: 'conv-1',
    conversationTitle: 'Implementação',
    arquivo: '2026-10-05-01.md',
    ordem: 1,
    loteId: 'hl-1',
    conteudo: 'Prompt 1',
    conteudoHash: 'hash-1',
    status: 'em_execucao',
    motivo: null,
    estimativaTotal: 30,
    prazoTotal: 30,
    atrasado: false,
    tempoAtivoMs: 0,
    retrabalhoMs: 0,
    criadoEm: AT,
    enviadoEm: AT,
    iniciadoEm: AT,
    concluidoEm: null,
    updatedAt: AT,
    entregas: [entrega()],
    ...over
  }
}

/** O envio em execução com duas etapas: a 1ª em andamento com `ms` de tempo ativo. */
export function running(ms: number, over: Partial<HandoffEntrega> = {}): HandoffEnvio {
  return envio({
    estimativaTotal: 50,
    prazoTotal: 50,
    entregas: [
      entrega({ status: 'em_andamento', tempoAtivoMs: ms, estimativaAgente: 20, estimativaAgenteMotivo: 'dois backends', ...over }),
      entrega({ id: 'hn-tela', etapaId: 'tela', etapaTitulo: 'Tela', ordem: 2, estimativaPlano: 20 })
    ]
  })
}
