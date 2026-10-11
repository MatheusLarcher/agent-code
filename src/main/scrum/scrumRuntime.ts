/**
 * O Scrum Master ATIVO do processo, para quem não o recebe por injeção: o hook
 * PostToolUse (handoffDeadlineHook.ts), a ferramenta `entrega_aviso_demora`
 * (entregaTools.ts) e a nota da parada no `send` da AgentSession. Molde:
 * handoffTracking/handoffRuntime.ts. O main registra; sem registro (testes,
 * banco indisponível), todo mundo segue como se o SM não existisse.
 */

export interface ScrumDeclaracaoPedido {
  minutos: unknown
  motivo: unknown
}

export interface ScrumMasterRuntime {
  /** A cobrança pendente da conversa, marcada como entregue; `null` = nenhuma. Síncrona: o hook só consulta o mapa. */
  takeCharge(convId: string): string | null
  /** A nota da parada do SM para a próxima mensagem, uma vez só; `null` = nenhuma. */
  takeStopNote(convId: string): string | null
  /** `entrega_aviso_demora`: o texto da resposta ao agente. Nunca rejeita. */
  declare(convId: string, pedido: ScrumDeclaracaoPedido): Promise<string>
}

let active: ScrumMasterRuntime | null = null

export function setActiveScrumMaster(sm: ScrumMasterRuntime | null): void {
  active = sm
}

export function activeScrumMaster(): ScrumMasterRuntime | null {
  return active
}
