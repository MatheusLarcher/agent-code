import type { ConversationChangeDto } from '../../../shared/ipc'

export { applyConversationChange } from '../../../shared/conversationChange'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/**
 * Fronteira do IPC: só passam mudanças bem formadas. Uma torta é descartada
 * sozinha (as outras do lote seguem) — o renderer manda a conversa inteira de
 * novo quando o main pede (`conversations:resync`).
 */
export function parseConversationChanges(raw: unknown): ConversationChangeDto[] {
  if (!Array.isArray(raw)) return []
  const changes: ConversationChangeDto[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || item.id.length > 200) continue
    if (item.deleted === true) {
      changes.push({ id: item.id, deleted: true, ...(item.urgent === true ? { urgent: true } : {}) })
      continue
    }
    if (item.top !== undefined && !isRecord(item.top)) continue
    if (item.messages !== undefined && (!Array.isArray(item.messages) || !isIndex(item.messagesFrom))) continue
    if (item.messageCount !== undefined && !isIndex(item.messageCount)) continue
    changes.push({
      id: item.id,
      ...(item.top !== undefined ? { top: item.top } : {}),
      ...(item.messages !== undefined ? { messagesFrom: item.messagesFrom as number, messages: item.messages } : {}),
      ...(item.messageCount !== undefined ? { messageCount: item.messageCount as number } : {}),
      ...(item.urgent === true ? { urgent: true } : {})
    })
  }
  return changes
}
