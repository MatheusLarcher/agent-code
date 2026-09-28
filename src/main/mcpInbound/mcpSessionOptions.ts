/**
 * Como uma sessão de conversa do MCP de entrada sobe, decidido no `agentStart`
 * a partir do registro de tarefas do main — nunca do que o renderer mandou:
 *
 * - `inboundMcp` do renderer é SEMPRE descartado (senão a tela, ou um script
 *   injetado nela, subiria processos arbitrários);
 * - com config registrada: os servidores do chamador, o "Permitir tudo" do app
 *   só nesta sessão (as travas de Windows, memórias e escopo continuam — ver
 *   handlePermission) e o modelo da tarefa (o que o chamador pediu, ou o padrão
 *   das tarefas MCP). O esforço fixo é recortado ao teto do modelo e o modo
 *   rápido cai onde o modelo não o tem — o provedor recusa o par inválido;
 * - `model: null` (sessão sem tarefa, ex.: o usuário escreveu na conversa depois
 *   de uma tarefa): servidores e permissões da config, e o modelo da conversa.
 */
import { clampEffortToModel, EFFORT_LEVELS, modelSupportsFastMode, type EffortLevel, type StartAgentOptions } from '../../shared/ipc'
import { MCP_TASK_MODEL } from './mcpConstants'
import type { McpConversationConfig } from './mcpTasks'

const isLevel = (e: string | undefined): e is EffortLevel => EFFORT_LEVELS.includes(e as EffortLevel)

export function applyInboundMcpOptions(
  opts: StartAgentOptions,
  config: McpConversationConfig | undefined,
  model: string | null = MCP_TASK_MODEL
): StartAgentOptions {
  const { inboundMcp: _fromRenderer, ...rest } = opts
  if (!config) return rest
  const inboundMcp = { cliente: config.cliente, servers: config.mcpServers }
  if (model === null) return { ...rest, skipPermissions: true, inboundMcp }
  return {
    ...rest,
    model,
    ...(isLevel(rest.effort) ? { effort: clampEffortToModel(model, rest.effort) } : {}),
    ...(rest.fastMode ? { fastMode: modelSupportsFastMode(model) } : {}),
    skipPermissions: true,
    inboundMcp
  }
}
