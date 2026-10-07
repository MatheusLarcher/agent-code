/**
 * O feed do chat no celular, espelhando o reduceMessages do renderer: o
 * histórico do `/api/history` mais os eventos ao vivo do SSE. Funções puras —
 * sempre devolvem uma lista nova (o React compara por referência).
 */
import type { ChatMsg, ConvSummary, UserMsg } from './types'

/** Eventos que são ESTADO, não conteúdo: uso da conta, "o turno emudeceu", plano e
 *  tarefas de fundo. No feed só engordariam a lista (a renderização é whitelist). */
export const STATE_ONLY = new Set(['rate-limit', 'stall-status', 'task-list', 'background-tasks', 'llm-call', 'tool-input-delta', 'turn-start', 'mirror-repair', 'agent-task'])

/** Chamadas que o PC desvia do feed: o plano de tarefas vira o card fixo. */
export const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

type Loose = { kind?: string; name?: string; parentToolUseId?: string | null }

/** Trabalho de subagente nunca entra no feed (no PC vai para o painel de agentes). */
export function isSubagentEvent(e: Loose): boolean {
  return (e.kind === 'tool-use' || e.kind === 'tool-result') && e.parentToolUseId != null
}

export function isHiddenMessage(m: Loose | null | undefined): boolean {
  if (!m || !m.kind) return true
  if (STATE_ONLY.has(m.kind)) return true
  if (isSubagentEvent(m)) return true
  return m.kind === 'tool-use' && PLAN_TOOLS.has(m.name ?? '')
}

/** Junta um evento ao feed: texto em streaming substitui pelo id, resultado de
 *  ferramenta se acopla à chamada, `result` marca a última resposta como final. */
export function reduce(list: ChatMsg[], e: ChatMsg): ChatMsg[] {
  if (STATE_ONLY.has(e.kind) || isSubagentEvent(e)) return list
  if (e.kind === 'tool-use' && PLAN_TOOLS.has(e.name)) return list
  if (e.kind === 'assistant-text') {
    const i = list.findIndex((m) => m.kind === 'assistant-text' && m.id === e.id)
    if (i >= 0) return replaceAt(list, i, { ...e })
  }
  if (e.kind === 'tool-result') {
    const j = list.findIndex((m) => m.kind === 'tool-use' && m.id === e.toolUseId)
    if (j < 0) return list
    return replaceAt(list, j, { ...list[j], result: { isError: e.isError, text: e.text } })
  }
  if (e.kind === 'result') {
    for (let k = list.length - 1; k >= 0; k--) {
      if (list[k].kind === 'assistant-text') return replaceAt(list, k, { ...list[k], answer: true })
    }
    return list
  }
  return [...list, e]
}

function replaceAt(list: ChatMsg[], i: number, m: ChatMsg): ChatMsg[] {
  const next = list.slice()
  next[i] = m
  return next
}

/**
 * Reconcilia os ecos "Na fila" com a fila que o PC publica para a conversa: some
 * o que o PC já tirou da fila, entra o que está lá e o celular ainda não mostra
 * (ex.: enviado offline ou pelo próprio PC).
 */
export function syncQueued(messages: ChatMsg[], conv: Pick<ConvSummary, 'queued'> | null, now = Date.now()): ChatMsg[] {
  if (!conv) return messages
  const pending = (conv.queued ?? []).map((q) => q.text)
  let changed = false
  const kept = messages.filter((m) => {
    if (m.kind !== 'user' || !(m as UserMsg).queued) return true
    const i = pending.indexOf((m as UserMsg).text)
    if (i < 0) {
      changed = true
      return false
    }
    pending.splice(i, 1)
    return true
  })
  if (!pending.length) return changed ? kept : messages
  return [
    ...kept,
    ...pending.map((text, i): UserMsg => ({ kind: 'user', id: `queued-${now}-${i}`, text, queued: true }))
  ]
}
