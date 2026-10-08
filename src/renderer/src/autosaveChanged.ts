import { syncConversations, type SyncStats } from './conversationSync'
import type { Conversation } from './types'

/**
 * O tique do autosave (debounce do App) só trata as conversas cujo OBJETO mudou
 * desde o último disparo: `pending` acumula os ids que o App viu mudar por
 * identidade entre um disparo e o próximo. Aqui o conjunto é esvaziado e vira o
 * `only` da entrega à fila de gravação do main — que não espera o banco, então
 * não há falha a devolver para o próximo tique: quem tenta de novo é a fila.
 */
export function syncChangedConversations(pending: Set<string>, list: Conversation[]): SyncStats {
  const only = new Set(pending)
  pending.clear()
  return syncConversations(list, { only })
}
