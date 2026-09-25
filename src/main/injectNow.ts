import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ImageAttachment } from '../shared/ipc'

/**
 * Botão "agora" da fila: a mensagem entra no turno EM ANDAMENTO, sem
 * interromper. O CLI lê mensagens com `priority: 'next'` entre uma ferramenta e
 * outra e segue o mesmo turno (um `result` só) — medido no SDK 0.3.281: o
 * agente terminou o pedido original e aplicou o ajuste.
 *
 * O risco não é perder o histórico, é o foco: o modelo pode tomar o pedido novo
 * como substituto do original. Por isso a mensagem vai marcada como ajuste.
 */
export const INJECT_NOW_MARKER =
  '[Mensagem do usuário enviada DURANTE a tarefa em andamento. É um ajuste ou complemento: ' +
  'NÃO cancela nem substitui o pedido anterior. Continue a tarefa original levando isto em conta.]'

export function buildInjectedMessage(text: string, images: readonly ImageAttachment[] | undefined, uuid: string): SDKUserMessage {
  const body = `${INJECT_NOW_MARKER}\n\n${text}`
  const content: unknown =
    images && images.length > 0
      ? [
          ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
          { type: 'text', text: body }
        ]
      : body
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    priority: 'next',
    uuid
  } as SDKUserMessage
}
