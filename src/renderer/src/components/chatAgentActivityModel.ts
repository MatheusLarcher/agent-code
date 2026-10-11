/**
 * O que o cartão de cada agente da aba Conversa mostra — PURO (sem React).
 *
 * A fonte é a trilha (agentTracks.ts): só chamadas de ferramenta, nunca o
 * raciocínio do subagente. Antes de desenhar, o que pode carregar segredo é
 * mascarado: o resultado de quem lê o cofre some e os placeholders do cofre
 * viram só o nome (o mesmo maskedText do contexto do chat).
 */
import type { AgentTrack } from '../agentTracks'
import { trackMessages, type ToolUseMessage } from '../office3d/chatPage'
import { maskedText } from '../office3d/codeScreen/contextView'
import { toolKind, toolTarget } from './toolLine'

export type ActivityState = 'trabalhando' | 'aguardando' | 'concluido' | 'interrompido' | 'erro'

export const STATE_LABEL: Record<ActivityState, string> = {
  trabalhando: 'trabalhando',
  aguardando: 'aguardando',
  concluido: 'concluído',
  interrompido: 'interrompido',
  erro: 'erro'
}

/** Ferramentas cujo resultado É o segredo (o valor real do cofre). */
const SECRET_TOOL = /(^|__)memory_secret_get$/
const HIDDEN_SECRET = '[valor do cofre oculto]'

export function activityState(track: AgentTrack): ActivityState {
  if (track.status === 'error') return 'erro'
  if (track.status === 'done') return track.task?.status === 'stopped' ? 'interrompido' : 'concluido'
  const last = track.steps[track.steps.length - 1]
  return last && last.endedAt === undefined && last.result === undefined ? 'trabalhando' : 'aguardando'
}

export function agentName(track: AgentTrack): string {
  return track.subagentType?.trim() || 'Subagente'
}

/** A tarefa recebida, sem o "Tipo: " que o rótulo da trilha traz na frente. */
export function taskText(track: AgentTrack): string {
  const prefix = track.subagentType ? `${track.subagentType}: ` : ''
  const text = prefix && track.label.startsWith(prefix) ? track.label.slice(prefix.length) : track.label
  return maskedText(text)
}

function describeCall(name: string, input: unknown): string {
  const target = maskedText(toolTarget(name, input).trim())
  return target ? `${toolKind(name)} ${target}` : toolKind(name)
}

/** A atividade atual: a última chamada de ferramenta (em voo = "Agora"). */
export function currentActivity(track: AgentTrack): string {
  const last = track.steps[track.steps.length - 1]
  if (last) {
    const running = track.status === 'running' && last.endedAt === undefined && last.result === undefined
    return `${running ? 'Agora' : 'Última ação'}: ${describeCall(last.name, last.input)}`
  }
  if (track.task?.lastToolName) return `Última ação: ${toolKind(track.task.lastToolName)}`
  return track.status === 'running' ? 'Iniciando…' : 'Nenhuma ação registrada'
}

/** As ações da trilha no formato do cartão de ferramenta, já mascaradas. */
export function safeStepMessages(track: AgentTrack): ToolUseMessage[] {
  const out: ToolUseMessage[] = []
  for (const m of trackMessages(track)) {
    if (m.kind !== 'tool-use') continue
    if (!m.result) { out.push(m); continue }
    const text = SECRET_TOOL.test(m.name) ? HIDDEN_SECRET : maskedText(m.result.text)
    out.push({ ...m, result: { ...m.result, text } })
  }
  return out
}

export function safeSummary(track: AgentTrack): string | undefined {
  const s = track.task?.summary?.trim()
  return s ? maskedText(s) : undefined
}
