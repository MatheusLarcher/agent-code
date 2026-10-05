import type { HandoffEntrega, HandoffEnvio } from '../../shared/handoffTracking'
import type { BoardItem } from '../../shared/ipc'

/**
 * Fábricas dos objetos do acompanhamento para os testes (regras puras, tracker e
 * IPC). Só teste importa daqui; valores padrão neutros, o teste muda o que importa.
 */

export const T0 = Date.parse('2026-10-05T12:00:00.000Z')

export function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function entrega(over: Partial<HandoffEntrega> = {}): HandoffEntrega {
  const etapaId = over.etapaId ?? 'etapa-a'
  return {
    id: `hn-${etapaId}`,
    envioId: 'he-1',
    etapaId,
    etapaTitulo: `Título de ${etapaId}`,
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
    updatedAt: iso(T0),
    ...over
  }
}

export function envio(over: Partial<HandoffEnvio> = {}): HandoffEnvio {
  return {
    id: 'he-1',
    planSlug: 'plano',
    planTitulo: 'Plano',
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
    criadoEm: iso(T0),
    enviadoEm: iso(T0),
    iniciadoEm: iso(T0),
    concluidoEm: null,
    updatedAt: iso(T0),
    entregas: [entrega()],
    ...over
  }
}

export function card(over: Partial<BoardItem> = {}): BoardItem {
  return {
    id: 'bi-1',
    projectId: 'proj-1',
    projectCwd: 'C:/proj',
    conversationId: 'conv-1',
    origin: 'agent',
    sourceId: '1',
    sourceTitle: '[etapa-a] Fazer a etapa A',
    sourceStatus: 'pending',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...over
  }
}
