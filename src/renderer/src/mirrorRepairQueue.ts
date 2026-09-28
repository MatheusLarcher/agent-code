import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import type { UIMessage } from './types'

/**
 * Envio durante o reparo do espelho do transcript (main/mirrorRepair.ts).
 *
 * Com o banco ainda fora, o main não envia a mensagem e avisa com o evento
 * `mirror-repair` `deferred`. Ela não pode ficar só na bolha: volta para a
 * CABEÇA da fila de espera da conversa — a mesma do agente ocupado, gravada em
 * conversation_outbox quando o banco deixa — e sai sozinha no `restored`.
 */

export interface DeferredInflight {
  msgId: string
  sdkUuid: string
  full: string
  images: ImageAttachment[]
  files: FileAttachment[]
  fileRefs: FileRefAttachment[]
  /** Tarefa do MCP de entrada da mensagem: volta à fila com ela. */
  mcpTaskId?: string
}

export interface RequeuedItem {
  id: string
  convId: string
  full: string
  text: string
  images: ImageAttachment[]
  thumbs: string[]
  files: FileAttachment[]
  fileRefs: FileRefAttachment[]
  mcpTaskId?: string
}

/**
 * Item da fila para a mensagem em voo recusada (texto e miniaturas vêm da
 * bolha dela) e o id da bolha a tirar do chat — ela volta como bolha quando
 * sair da fila. `null` quando o evento não é da mensagem em voo desta
 * conversa: nada muda.
 */
export function requeueDeferredSend(
  convId: string,
  messageUuid: string,
  inflight: DeferredInflight | undefined,
  messages: readonly UIMessage[],
  newId: string
): { item: RequeuedItem; bubbleId: string } | null {
  if (!inflight || inflight.sdkUuid !== messageUuid) return null
  const bubble = messages.find((message) => message.kind === 'user' && message.id === inflight.msgId)
  const user = bubble?.kind === 'user' ? bubble : undefined
  return {
    item: {
      id: newId,
      convId,
      full: inflight.full,
      text: user?.text ?? inflight.full,
      images: inflight.images,
      thumbs: user?.images ?? [],
      files: inflight.files,
      fileRefs: inflight.fileRefs,
      ...(inflight.mcpTaskId ? { mcpTaskId: inflight.mcpTaskId } : {})
    },
    bubbleId: inflight.msgId
  }
}

/** A mesma bolha sem a mensagem devolvida à fila. */
export function withoutBubble(messages: readonly UIMessage[], bubbleId: string): UIMessage[] {
  return messages.filter((message) => !(message.kind === 'user' && message.id === bubbleId))
}

/** Cabeça da fila da conversa a despachar quando o espelho volta; `null` se a
 *  conversa está ocupada ou em recuperação de turno (quem drena é o fim do
 *  turno) ou sem fila. */
export function queueHeadToDrain<T extends { convId: string }>(queue: readonly T[], convId: string, blocked: boolean): T | null {
  if (blocked) return null
  return queue.find((item) => item.convId === convId) ?? null
}
