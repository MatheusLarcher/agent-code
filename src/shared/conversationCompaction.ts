/** Conversas mais velhas que isto guardam só a narrativa útil (ver `compactConversation`). */
export const COMPACTION_AGE_MS = 15 * 24 * 60 * 60 * 1000

interface CompactionMessage {
  kind?: unknown
  answer?: unknown
}

/**
 * Conversa com mais de 15 dias fica só com o que o usuário pediu e as respostas
 * finais do agente. Mexe só no histórico desenhado pelo Agent Code, nunca nos
 * arquivos de sessão do SDK. A tela aplica ao carregar; a fila de gravação, ao
 * preparar o documento que vai para o banco. Sem o que mudar, a própria conversa.
 */
export function compactConversation<T extends { createdAt?: unknown; messages?: unknown }>(
  conversation: T,
  now = Date.now()
): T {
  const messages = Array.isArray(conversation.messages) ? (conversation.messages as CompactionMessage[]) : []
  const createdAt = conversation.createdAt
  if (typeof createdAt === 'number' && Number.isFinite(createdAt) && now - createdAt < COMPACTION_AGE_MS) {
    return messages === conversation.messages ? conversation : { ...conversation, messages }
  }
  const compacted = messages.filter(
    (message) => message?.kind === 'user' || (message?.kind === 'assistant-text' && Boolean(message.answer))
  )
  return compacted.length === messages.length && messages === conversation.messages
    ? conversation
    : { ...conversation, messages: compacted }
}
