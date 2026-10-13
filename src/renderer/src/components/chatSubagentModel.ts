/**
 * O que a linha de cada subagente do chat mostra (ChatSubagent.tsx) — PURO
 * (sem React).
 *
 * A fonte são as próprias mensagens (chatSteps.ts → `subagents`): a chamada
 * Task/Agent do agente principal e as ferramentas do subagente. Assim vale ao
 * vivo e no histórico. Nunca o raciocínio do subagente. Antes de desenhar, o
 * que pode carregar segredo é mascarado: o resultado de quem lê o cofre some e
 * os placeholders do cofre viram só o nome (o mesmo maskedText do contexto do chat).
 */
import type { UIMessage } from '../types'
import { maskedText } from '../office3d/codeScreen/contextView'
import type { ChatSubagent } from './chatSteps'
import type { ToolUseMessage } from './ToolCard'

export type SubagentState = 'trabalhando' | 'concluido' | 'interrompido' | 'erro'

export const STATE_LABEL: Record<SubagentState, string> = {
  trabalhando: 'trabalhando',
  concluido: 'concluído',
  interrompido: 'interrompido',
  erro: 'erro'
}

/** Ferramentas cujo resultado É o segredo (o valor real do cofre). */
const SECRET_TOOL = /(^|__)memory_secret_get$/
const HIDDEN_SECRET = '[valor do cofre oculto]'
/** Teto do texto da tarefa na linha (o resto fica no tooltip). */
const TASK_MAX = 160

type Sub = ChatSubagent<UIMessage>

const asTool = (m: UIMessage): ToolUseMessage | null => (m.kind === 'tool-use' ? m : null)

function field(input: unknown, key: string): string {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof v === 'string' ? v.trim() : ''
}

export function subagentState(sub: Sub): SubagentState {
  if (sub.running) return 'trabalhando'
  const result = asTool(sub.call)?.result
  if (!result) return 'interrompido'
  return result.isError ? 'erro' : 'concluido'
}

/** Quem trabalha: o tipo do subagente (SDK `subagent_type`), senão "Subagente". */
export function subagentName(sub: Sub): string {
  const call = asTool(sub.call)
  return call?.subagentType?.trim() || field(call?.input, 'subagent_type') || 'Subagente'
}

/** A tarefa recebida: a descrição curta; sem ela, a 1ª linha do prompt. Mascarada. */
export function subagentTask(sub: Sub): string {
  const call = asTool(sub.call)
  const raw = call?.taskDescription?.trim() || field(call?.input, 'description') || field(call?.input, 'prompt').split('\n')[0].trim()
  const text = maskedText(raw)
  return text.length > TASK_MAX ? `${text.slice(0, TASK_MAX - 1)}…` : text
}

/**
 * O resultado de uma ferramenta sem segredo: o de quem lê o cofre some, os placeholders viram o
 * nome. Usado ao GRAVAR a ferramenta do subagente (reduceMessages.ts) e de novo ao desenhar.
 */
export function safeResultText(toolName: string, text: string): string {
  return SECRET_TOOL.test(toolName) ? HIDDEN_SECRET : maskedText(text)
}

/** Uma ferramenta pronta para o cartão: o resultado do cofre some, os placeholders viram o nome. */
export function safeToolMessage(m: UIMessage): UIMessage {
  const t = asTool(m)
  if (!t?.result) return m
  const text = safeResultText(t.name, t.result.text)
  return text === t.result.text ? m : { ...t, result: { ...t.result, text } }
}

/** O relatório do subagente (o resultado da chamada), mascarado; undefined = ainda sem. */
export function subagentReport(sub: Sub): string | undefined {
  const text = asTool(sub.call)?.result?.text?.trim()
  return text ? maskedText(text) : undefined
}
