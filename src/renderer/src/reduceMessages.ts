/**
 * O redutor puro da lista de mensagens de uma conversa (eventos de sistema e o
 * plano de tarefas ficam com quem chama, em App.tsx) — sem React, testável.
 *
 * As ferramentas de subagente (`parentToolUseId`) entram na conversa, mas o chat
 * nunca as põe na linha principal: viram filho da chamada Task/Agent
 * (chatSteps.ts → ChatSubagent.tsx). O resultado delas é GRAVADO já sem segredo
 * (o do cofre some, os placeholders viram o nome — o mesmo safeResultText do
 * desenho, que mascara de novo) e aparado.
 */
import type { ChatEvent } from '@shared/ipc'
import { isSubagentEvent } from './agentTracks'
import { safeResultText } from './components/chatSubagentModel'
import type { UIMessage } from './types'

/** Teto do resultado de uma ferramenta de subagente guardado na conversa (o completo fica no transcript do CLI). */
export const SUBAGENT_RESULT_MAX = 4000

type ToolUseEvent = Extract<ChatEvent, { kind: 'tool-use' }>

/** True for the tool-use event that carries a TodoWrite call — these are
 *  diverted to `Conversation.todoPlan` (see `extractTodoPlan`) instead of
 *  becoming a generic ToolCard in the message feed. */
export function isTodoWriteToolUse(e: ChatEvent): e is ToolUseEvent {
  return e.kind === 'tool-use' && e.name === 'TodoWrite'
}

/** TaskCreate/TaskUpdate are the tool pair actually used in practice today
 *  (TodoWrite is kept working above but real sessions don't call it) — same
 *  treatment: diverted to `Conversation.todoPlan` instead of the message feed. */
export function isTaskCreateToolUse(e: ChatEvent): e is ToolUseEvent {
  return e.kind === 'tool-use' && e.name === 'TaskCreate'
}
export function isTaskUpdateToolUse(e: ChatEvent): e is ToolUseEvent {
  return e.kind === 'tool-use' && e.name === 'TaskUpdate'
}

export function reduceMessages(prev: UIMessage[], e: ChatEvent): UIMessage[] {
  // TodoWrite/TaskCreate/TaskUpdate calls never join the message feed — they
  // update Conversation.todoPlan instead (handled in onEvent, alongside this call).
  if (isTodoWriteToolUse(e) || isTaskCreateToolUse(e) || isTaskUpdateToolUse(e)) return prev
  // `llm-call` alimenta só a árvore de consumo de tokens (ver TokenUsagePanel);
  // uma bolha por chamada ao modelo inundaria o chat.
  if (e.kind === 'background-tasks' || e.kind === 'task-list' || e.kind === 'llm-call') return prev
  if (e.kind === 'assistant-text') {
    const i = prev.findIndex((m) => m.kind === 'assistant-text' && m.id === e.id)
    if (i >= 0) {
      const copy = [...prev]
      copy[i] = { ...e }
      return copy
    }
  }
  if (e.kind === 'tool-result') {
    const i = prev.findIndex((m) => m.kind === 'tool-use' && m.id === e.toolUseId)
    if (i >= 0) {
      const tool = prev[i]
      const text = isSubagentEvent(e) && tool.kind === 'tool-use' ? subagentResultText(tool.name, e.text) : e.text
      const copy = [...prev]
      copy[i] = { ...tool, result: { isError: e.isError, text } } as UIMessage
      return copy
    }
    // Orphaned result — its tool-use was diverted above (TodoWrite/Task*), so
    // there's nothing in `prev` to attach it to. Drop it rather than letting
    // it fall through and land as a standalone message with no context.
    return prev
  }
  if (e.kind === 'result') {
    // The result text duplicates the final answer and the cost is in the header,
    // so we don't render it — we only mark the last assistant text as the answer.
    const copy = [...prev]
    for (let i = copy.length - 1; i >= 0; i--) {
      if (copy[i].kind === 'assistant-text') {
        // Stamp the finish time so the chat can show when this answer ran (and,
        // if today, how long ago).
        copy[i] = { ...copy[i], answer: true, ts: Date.now() }
        break
      }
    }
    return copy
  }
  if (e.kind === 'system') {
    // Remove any existing system events with the same model and cwd
    // since we only want to show the latest status for a given model/cwd combination
    const filtered = prev.filter((m) => !(m.kind === 'system' && m.model === e.model && m.cwd === e.cwd))
    return [...filtered, e as UIMessage]
  }
  return [...prev, e as UIMessage]
}

/** O resultado do subagente como fica gravado: mascarado ANTES de aparar (o corte não parte um placeholder). */
function subagentResultText(toolName: string, raw: string): string {
  const text = safeResultText(toolName, raw)
  return text.length > SUBAGENT_RESULT_MAX ? `${text.slice(0, SUBAGENT_RESULT_MAX)}\n…` : text
}
