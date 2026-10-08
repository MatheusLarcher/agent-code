import type { ConversationChangeDto } from '@shared/ipc'
import type { Conversation, UIMessage } from './types'

/**
 * A tela entrega à fila de gravação do main só o que mudou — e não espera o banco.
 *
 * Mudança = objeto de conversa diferente do que já foi entregue e que não veio do
 * banco (o React troca o objeto de toda conversa alterada; comparar identidade é
 * barato). Nada de cópia profunda nem de serialização estável aqui: isso rodava a
 * cada tique do autosave no thread da UI. A 1ª entrega de cada conversa leva o
 * documento inteiro; as seguintes, os campos de topo (se mudaram) e as mensagens
 * a partir da primeira que mudou — no streaming, só a cauda.
 */

/** O que o main já tem de cada conversa: o objeto e o array de mensagens entregues. */
const delivered = new Map<string, { conv: Conversation; messages: UIMessage[] }>()
/** Objetos que vieram do banco (leitura, hidratação, feed): não são edição local.
 *  Por identidade — carregar de novo uma conversa que já está na tela não mexe na
 *  base dela. */
let stored = new WeakSet<Conversation>()
/** Conversas que já estiveram na lista entregue: sair dela = apagar. Uma conversa
 *  só carregada (ainda fora da tela) nunca vira exclusão. */
const listed = new Set<string>()
/** Mudou na tela e ainda não foi entregue: o feed de mudanças não a sobrescreve. */
const dirty = new Set<string>()
/** A próxima entrega destas vai urgente (fim de turno, troca de conversa). */
const urgentIds = new Set<string>()

export interface SyncStats {
  /** Conversas comparadas neste tique. */
  processed: number
  /** Mudanças entregues ao main. */
  sent: number
}

/** As conversas que vieram do banco ficam como base: só a mudança local é entregue. */
export function markConversationsLoaded(list: Iterable<Conversation>): void {
  for (const conversation of list) stored.add(conversation)
}

/** Marca como alteradas ANTES do tique do autosave (ver App: identidade mudou). */
export function markConversationsDirty(ids: Iterable<string>): void {
  for (const id of ids) dirty.add(id)
}

export function isConversationDirty(id: string): boolean {
  return dirty.has(id)
}

/** A próxima entrega destas conversas grava já, sem o ritmo de ~1/s. */
export function markConversationsUrgent(ids: Iterable<string | null | undefined>): void {
  for (const id of ids) if (id) urgentIds.add(id)
}

/** O main perdeu a base desta conversa: a próxima entrega leva o documento inteiro. */
export function forgetDelivered(id: string): void {
  delivered.delete(id)
  dirty.add(id)
}

/** Apagada noutro PC (o feed já a tirou da tela): não vira exclusão daqui. */
export function forgetConversation(id: string): void {
  delivered.delete(id)
  listed.delete(id)
  dirty.delete(id)
}

/** Bytes de imagem nunca vão para o banco (o `images` da bolha é só da tela). */
function lean(message: UIMessage): UIMessage {
  if (!message || typeof message !== 'object' || !('images' in message)) return message
  const { images: _images, ...rest } = message as UIMessage & { images?: unknown }
  return rest as UIMessage
}

function topOf(conversation: Conversation): Record<string, unknown> {
  const { messages: _messages, ...top } = conversation
  return top as Record<string, unknown>
}

function topChanged(next: Conversation, previous: Conversation): boolean {
  const a = next as unknown as Record<string, unknown>
  const b = previous as unknown as Record<string, unknown>
  for (const key of Object.keys(a)) if (key !== 'messages' && a[key] !== b[key]) return true
  for (const key of Object.keys(b)) if (key !== 'messages' && !(key in a)) return true
  return false
}

function changeFor(conversation: Conversation): ConversationChangeDto | null {
  const id = conversation.id
  const last = delivered.get(id)
  if (last?.conv === conversation || stored.has(conversation)) return null
  const messages = Array.isArray(conversation.messages) ? conversation.messages : []
  delivered.set(id, { conv: conversation, messages })
  if (!last) {
    return { id, top: topOf(conversation), messagesFrom: 0, messages: messages.map(lean), messageCount: messages.length }
  }
  let from = 0
  const shared = Math.min(messages.length, last.messages.length)
  while (from < shared && messages[from] === last.messages[from]) from += 1
  const messagesChanged = from < messages.length || messages.length !== last.messages.length
  const fieldsChanged = topChanged(conversation, last.conv)
  if (!messagesChanged && !fieldsChanged) return null
  return {
    id,
    ...(fieldsChanged ? { top: topOf(conversation) } : {}),
    ...(messagesChanged ? { messagesFrom: from, messages: messages.slice(from).map(lean), messageCount: messages.length } : {})
  }
}

/**
 * Entrega à fila do main o que mudou desde a última entrega, sem esperar. Com
 * `only`, só essas conversas (o tique do autosave sabe quem mudou); a detecção de
 * apagadas olha a lista inteira — `list` é sempre a lista inteira da tela.
 * `urgent`: grava já, sem o ritmo de ~1/s (fim de turno, envio, fechar).
 */
export function syncConversations(
  list: Conversation[],
  options?: { only?: ReadonlySet<string>; urgent?: boolean }
): SyncStats {
  const only = options?.only
  const urgent = options?.urgent === true
  const changes: ConversationChangeDto[] = []
  const present = new Set<string>()
  let processed = 0
  for (const conversation of list) {
    present.add(conversation.id)
    listed.add(conversation.id)
    if (only && !only.has(conversation.id)) continue
    processed += 1
    const change = changeFor(conversation)
    dirty.delete(conversation.id)
    if (!change) continue
    const now = urgent || urgentIds.has(conversation.id)
    urgentIds.delete(conversation.id)
    changes.push(now ? { ...change, urgent: true } : change)
  }
  for (const id of listed) {
    if (present.has(id)) continue
    listed.delete(id)
    delivered.delete(id)
    dirty.delete(id)
    urgentIds.delete(id)
    changes.push({ id, deleted: true, ...(urgent ? { urgent } : {}) })
  }
  if (changes.length) window.api.syncConversations(changes)
  return { processed, sent: changes.length }
}

/** Só para testes: esquece tudo o que foi entregue e carregado. */
export function resetConversationSync(): void {
  delivered.clear()
  stored = new WeakSet()
  listed.clear()
  dirty.clear()
  urgentIds.clear()
}
