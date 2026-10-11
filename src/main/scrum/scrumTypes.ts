import type { ScrumMarco, ScrumTipoDesvio, ScrumVereditoTipo } from '../../shared/scrumPanel'
import { HANDOFF_STALL_MS } from '../handoffTracking/handoffActivity'

// As linhas do diário são lidas também pela tela (o painel do SM): os tipos moram em shared.
export { SCRUM_DESVIOS } from '../../shared/scrumPanel'
export type { ScrumDecisao, ScrumDecisaoTipo, ScrumGatilho, ScrumMarco, ScrumTipoDesvio, ScrumVereditoTipo } from '../../shared/scrumPanel'

/**
 * O SCRUM MASTER (SM): o agente que COBRA. Acompanha os envios de handoff em
 * execução e age quando a etapa passa do prazo ou o agente trava.
 *
 * Ele CONSOME o que já existe e não duplica: o prazo e o tempo ativo são medidos
 * em handoffDeadline.ts (que avisa o agente em 80% e 100%), o quadro é do PO e a
 * qualidade da entrega é do crítico. Só envio de handoff com prazo
 * (`estimativaPlano > 0`) e só conversa com sessão viva NESTE processo.
 */

/** Os marcos do SM, em % do prazo da etapa. O de 100% continua sendo o aviso
 *  fixo de handoffDeadline.ts; o SM começa depois dele. */
export const SCRUM_MARCOS: readonly ScrumMarco[] = [150, 200, 300]

/** Cobrança pendente sem chegar ao agente por tanto tempo, COM turno rodando,
 *  leva à avaliação de agente travado: o mesmo teto da parada por inatividade. */
export const SCRUM_ESPERA_ENTREGA_MS = HANDOFF_STALL_MS

/** A declaração de tarefa demorada vale sozinha até tantas vezes o prazo da
 *  etapa; acima disso vale o teto e o usuário é avisado para aprovar. */
export const SCRUM_TETO_DECLARACAO = 3

/** A variável de dev que encurta o prazo que o SM enxerga (0 < x ≤ 1). Ignorada
 *  no app empacotado; inválida vale 1. */
export const SCRUM_ESCALA_ENV = 'AGENT_CODE_SCRUM_ESCALA'

/** O veredito do modelo. `falha` = não respondeu ou respondeu sem veredito: vai a
 *  cobrança de texto fixo e nunca há corte nem parada. */
export interface ScrumVeredito {
  veredito: ScrumVereditoTipo
  /** Só no `desvio`; `null` quando o modelo não deu um tipo conhecido. */
  tipoDesvio: ScrumTipoDesvio | null
  motivo: string
  /** O texto da linha COBRANCA; `null` quando o modelo não a mandou. */
  cobranca: string | null
}

/** A declaração de tarefa demorada (`entrega_aviso_demora`), por envio e entrega. */
export interface ScrumDeclaracao {
  envioId: string
  entregaId: string
  /** O que o agente pediu. */
  pedidoMin: number
  /** O que valeu: o pedido até o teto (SCRUM_TETO_DECLARACAO × prazo). */
  validoMin: number
  motivo: string
  /** Quando foi declarada (ms). */
  at: number
  /** O pedido passou do teto: o usuário foi avisado para aprovar. */
  acimaDoTeto: boolean
  /** O que o usuário decidiu no painel (só acima do teto); ausente = ainda não. */
  decidida?: 'aprovou' | 'recusou'
}
