import type { ConversationChangeDto } from './ipc'

type ConversationDoc = Record<string, unknown>

/**
 * O instantâneo depois da mudança: os campos de topo novos (ou os de antes) e as
 * mensagens até `messagesFrom` de antes, seguidas das que vieram. `null` quando
 * quem aplica não tem a base que a mudança supõe (precisa da conversa inteira).
 * A fila do main aplica; os testes da tela usam a mesma regra no banco falso.
 */
export function applyConversationChange<T extends ConversationDoc>(
  base: T | undefined,
  change: ConversationChangeDto
): T | null {
  const before = Array.isArray(base?.messages) ? (base.messages as unknown[]) : []
  const from = change.messagesFrom ?? before.length
  if (!base && (change.top === undefined || from > 0)) return null
  if (from > before.length) return null
  const top = (change.top ?? base) as ConversationDoc | undefined
  if (!top) return null
  const messages = change.messages === undefined ? before : [...before.slice(0, from), ...change.messages]
  if (change.messageCount !== undefined && messages.length !== change.messageCount) return null
  const { messages: _dropped, ...fields } = top
  return { ...fields, id: change.id, messages } as unknown as T
}
