/**
 * Ciclo de vida das tarefas do SDK → evento `agent-task` do renderer.
 *
 * O SDK anuncia cada tarefa (subagente, shell em segundo plano…) por quatro
 * mensagens `system`: `task_started` (com `tool_use_id` e `is_backgrounded`),
 * `task_progress` (última ferramenta, contagem), `task_updated` (patch de
 * status, SEM `tool_use_id`) e `task_notification` (o fim). Os passos do
 * subagente chegam à parte, como mensagens com `parent_tool_use_id`.
 *
 * Rede de segurança pelos hooks: o `SubagentStop` (cujo `agent_id` é o
 * `task_id`) também fecha a tarefa, para o caso de o `task_notification` não
 * chegar. Os hooks dão só o FIM, nunca passos (esses já vêm pelas mensagens). O
 * `tool_use_id` sai do `task_started` ou, se ele faltou, da correlação entre o
 * `PreToolUse` do subagente (agent_id + id do passo) e o `parent_tool_use_id`
 * daquele passo. Dedupe: vence o primeiro fim; o do SDK que vier depois só
 * passa se corrigir o status (falhou/parado em vez de concluído).
 *
 * Os campos vêm do CLI: tudo é validado aqui e o que faltar fica ausente.
 */
import type { AgentTaskInfo, AgentTaskPhase, AgentTaskStatus, ChatEvent } from '../shared/ipc'

export type AgentTaskEvent = Extract<ChatEvent, { kind: 'agent-task' }>

/** Tarefas lembradas (task_id → tool_use_id). Sobra só de tarefa que nunca notificou. */
const MAX_KNOWN = 200
const TEXT_MAX = 300

const SUBTYPE_PHASE: Record<string, AgentTaskPhase> = {
  task_started: 'started',
  task_progress: 'progress',
  task_updated: 'updated',
  task_notification: 'notification'
}

function str(v: unknown, max = TEXT_MAX): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t) return undefined
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined
}

/** Status do patch do `task_updated` (vocabulário do TaskState do CLI). */
function patchStatus(v: unknown): AgentTaskStatus | undefined {
  switch (v) {
    case 'pending':
    case 'running':
    case 'paused':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'killed':
      return 'stopped'
    default:
      return undefined
  }
}

function notificationStatus(v: unknown): AgentTaskStatus {
  return v === 'completed' || v === 'failed' || v === 'stopped' ? v : 'completed'
}

/**
 * Traduz UMA mensagem do SDK. `known` guarda o tool_use_id de cada tarefa (o
 * `task_updated` não o traz) e é atualizado aqui. Devolve `null` para o que não
 * é ciclo de tarefa, para tarefa ambiente (o SDK pede para não contar como
 * atividade) e para mensagem malformada.
 */
export function translateTaskMessage(message: unknown, known: Map<string, string>): AgentTaskEvent | null {
  if (!message || typeof message !== 'object') return null
  const m = message as Record<string, unknown>
  if (m.type !== 'system' || typeof m.subtype !== 'string') return null
  const phase = SUBTYPE_PHASE[m.subtype]
  if (!phase) return null
  const taskId = str(m.task_id, 200)
  if (!taskId) return null
  if (m.ambient === true || m.skip_transcript === true) return null

  const toolUseId = str(m.tool_use_id, 200) ?? known.get(taskId)
  let info: AgentTaskInfo
  if (phase === 'started') {
    info = {
      taskId,
      status: 'running',
      ...(typeof m.is_backgrounded === 'boolean' ? { backgrounded: m.is_backgrounded } : {}),
      ...(str(m.task_type, 60) ? { taskType: str(m.task_type, 60) } : {}),
      ...(str(m.subagent_type, 80) ? { subagentType: str(m.subagent_type, 80) } : {}),
      ...(str(m.description) ? { description: str(m.description) } : {})
    }
  } else if (phase === 'progress') {
    const usage = (m.usage ?? {}) as Record<string, unknown>
    info = {
      taskId,
      status: 'running',
      ...(str(m.subagent_type, 80) ? { subagentType: str(m.subagent_type, 80) } : {}),
      ...(str(m.description) ? { description: str(m.description) } : {}),
      ...(str(m.last_tool_name, 120) ? { lastToolName: str(m.last_tool_name, 120) } : {}),
      ...(str(m.summary) ? { summary: str(m.summary) } : {}),
      ...(count(usage.tool_uses) !== undefined ? { toolUses: count(usage.tool_uses) } : {})
    }
  } else if (phase === 'updated') {
    const patch = (m.patch && typeof m.patch === 'object' ? m.patch : {}) as Record<string, unknown>
    const status = patchStatus(patch.status)
    const backgrounded = typeof patch.is_backgrounded === 'boolean' ? patch.is_backgrounded : undefined
    // Patch só de tempo/descrição: nada que a trilha use.
    if (!status && backgrounded === undefined) return null
    info = {
      taskId,
      status: status ?? 'running',
      ...(backgrounded !== undefined ? { backgrounded } : {}),
      ...(str(patch.description) ? { description: str(patch.description) } : {})
    }
  } else {
    const usage = (m.usage ?? {}) as Record<string, unknown>
    info = {
      taskId,
      status: notificationStatus(m.status),
      ...(str(m.summary) ? { summary: str(m.summary) } : {}),
      ...(count(usage.tool_uses) !== undefined ? { toolUses: count(usage.tool_uses) } : {})
    }
  }
  if (toolUseId) info.toolUseId = toolUseId

  if (phase === 'started' && toolUseId) {
    if (known.size >= MAX_KNOWN) known.delete(known.keys().next().value as string)
    known.set(taskId, toolUseId)
  } else if (info.status !== 'running') {
    known.delete(taskId)
  }
  return { kind: 'agent-task', phase, ...info }
}

/** Quem fechou a tarefa primeiro. */
type EndSource = 'task' | 'hook'

/** Passos de subagente lembrados (id do passo → tool_use_id do Agent). */
const MAX_STEPS = 500

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key)
  if (map.size >= max) map.delete(map.keys().next().value as string)
  map.set(key, value)
}

/** O estado por sessão do tradutor (uma instância por AgentSession). */
export class AgentTaskTranslator {
  private readonly known = new Map<string, string>()
  private readonly ended = new Map<string, EndSource>()
  private readonly steps = new Map<string, string>()

  translate(message: unknown): AgentTaskEvent | null {
    const ev = translateTaskMessage(message, this.known)
    if (!ev || ev.status === 'running') return ev
    const first = this.ended.get(ev.taskId)
    remember(this.ended, ev.taskId, first ?? 'task', MAX_KNOWN)
    // O hook já fechou como concluída: repetir seria duplicata.
    if (first === 'hook' && ev.status === 'completed') return null
    return ev
  }

  /** Os tool_use de uma mensagem de subagente (para achar a trilha pelo hook). */
  noteSteps(blocks: unknown, parentToolUseId: string): void {
    if (!Array.isArray(blocks)) return
    for (const b of blocks) {
      const block = b as { type?: unknown; id?: unknown } | null
      if (block?.type === 'tool_use' && typeof block.id === 'string') remember(this.steps, block.id, parentToolUseId, MAX_STEPS)
    }
  }

  /** `PreToolUse` dentro de um subagente: liga o agent_id à trilha pelo passo. */
  noteHookTool(agentId: unknown, toolUseId: unknown): void {
    if (typeof agentId !== 'string' || !agentId || typeof toolUseId !== 'string') return
    if (this.known.has(agentId) || this.ended.has(agentId)) return
    const parent = this.steps.get(toolUseId)
    if (parent) remember(this.known, agentId, parent, MAX_KNOWN)
  }

  /**
   * `SubagentStop`: o fim da tarefa pelo hook. `null` quando o SDK já fechou
   * (dedupe) ou quando não há trilha conhecida para fechar.
   */
  fromSubagentStop(input: unknown): AgentTaskEvent | null {
    if (!input || typeof input !== 'object') return null
    const h = input as Record<string, unknown>
    if (h.hook_event_name !== 'SubagentStop') return null
    const taskId = str(h.agent_id, 200)
    if (!taskId || this.ended.has(taskId)) return null
    const toolUseId = this.known.get(taskId)
    if (!toolUseId) return null
    this.known.delete(taskId)
    remember(this.ended, taskId, 'hook', MAX_KNOWN)
    const summary = str(h.last_assistant_message)
    return { kind: 'agent-task', phase: 'notification', taskId, toolUseId, status: 'completed', ...(summary ? { summary } : {}) }
  }
}
