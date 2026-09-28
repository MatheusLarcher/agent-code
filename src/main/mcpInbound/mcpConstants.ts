/**
 * Constantes do servidor MCP de entrada (contrato Forgia → Agent Code). Cada
 * uma mora num lugar só: trocar exige publicar os dois apps juntos.
 */

/** Token fixo do contrato, igual nos dois apps (decisão do usuário). Público —
 *  o Forgia é código aberto —, então só barra chamada acidental; o que barra
 *  página web é a recusa de `Origin` e a checagem de `Host`, sempre juntas. */
export const MCP_INBOUND_TOKEN = 'fgac_cFCfAYvVfH0UxI4ZppNsH9s58YSpSmcDd5SSBBso4qc'

/** Faixa 47110–47149 (40 portas): sem registro na IANA, fora da efêmera do
 *  Windows (49152+) e das exclusões Hyper-V/WSL conhecidas desta máquina. */
export const MCP_INBOUND_PORT_START = 47110
export const MCP_INBOUND_PORT_COUNT = 40

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MCP_SERVER_NAME = 'agent-code'

export { MCP_TASK_MODEL } from '../../shared/mcpInbound'
import { MCP_TASK_GONE_MARK } from '../../shared/mcpInbound'

/** Tarefa MCP apontada para uma conversa do Agent Manager (planejamento). */
export const MCP_PLANNING_REFUSED =
  'Esta conversa é do Agent Manager (planejamento): tarefas do MCP de entrada não rodam nela. Use outra conversa ou omita conversa_id.'

/** Regra 1 (erro do `agent:send`/"agora", visto pela tela): envio com o id de
 *  uma tarefa que não está viva. Leva a marca que a tela reconhece. */
export const MCP_TASK_GONE = `${MCP_TASK_GONE_MARK} Esta tarefa do MCP de entrada já terminou (concluída, cancelada ou com erro) ou não existe mais (o app foi reiniciado): o Agent Code não a roda de novo nem a manda como mensagem sua. Quem a enviou pode reenviá-la.`

/** Regra 2 (defesa do main): a retomada automática depois de um turno de tarefa
 *  que terminou em erro. O app não repete sozinho um turno de tarefa MCP. */
export const MCP_NO_AUTO_RETRY = `${MCP_TASK_GONE_MARK} O turno anterior era de uma tarefa do MCP de entrada e terminou em erro: o Agent Code não repete sozinho um turno de tarefa. Quem a enviou decide reenviar.`

/** Erro da TAREFA (visto pelo chamador): a sessão da conversa foi refeita no
 *  meio do turno dela (reconexão, outra sessão subiu) e o turno se perdeu. */
export const MCP_SESSION_REPLACED =
  'A sessão da conversa foi refeita no meio da tarefa (reconexão) e o turno dela se perdeu. O Agent Code não retoma tarefa sozinho: reenvie a tarefa.'

/** Nomes de servidor MCP que a sessão já usa: o chamador não pode sobrescrevê-los. */
export const RESERVED_MCP_SERVER_NAMES = ['browser', 'android', 'app', 'windows', 'memory', 'tasks', 'planning'] as const
