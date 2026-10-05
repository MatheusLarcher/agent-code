import { saveConversations, type SaveConversationsStats } from './storage'
import type { Conversation } from './types'

/**
 * O tique do autosave (debounce do App) só trata as conversas cujo OBJETO mudou
 * desde o último disparo: `pending` acumula os ids que o App viu mudar por
 * identidade entre um disparo e o próximo. Aqui o conjunto é esvaziado e vira o
 * `only` do salvamento; se a gravação falhar, os ids voltam para o próximo tique
 * tentar de novo. A comparação estável (ver `serialized` em storage.ts) continua
 * valendo para cada conversa tratada.
 */
export function saveChangedConversations(
  pending: Set<string>,
  list: Conversation[]
): Promise<SaveConversationsStats> {
  const only = new Set(pending)
  pending.clear()
  return saveConversations(list, { only }).catch((error: unknown) => {
    for (const id of only) pending.add(id)
    throw error
  })
}
