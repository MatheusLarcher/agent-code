import { applyConversationChange } from '@shared/conversationChange'
import type { ConversationChangeDto } from '@shared/ipc'

/**
 * Só para testes da tela: o "banco" que recebe o que a tela entrega à fila de
 * gravação do main. Aplica cada mudança com a MESMA regra da fila
 * (shared/conversationChange.ts) e guarda na hora — a fila de verdade (ritmo,
 * conflito, diário, carimbo do esforço) tem os testes dela no main.
 */

type Doc = Record<string, unknown> & { id: string }

export function applyChanges<T extends Doc>(docs: T[], changes: ConversationChangeDto[]): T[] {
  let next = docs
  for (const change of JSON.parse(JSON.stringify(changes)) as ConversationChangeDto[]) {
    if (change.deleted) {
      next = next.filter((doc) => doc.id !== change.id)
      continue
    }
    const base = next.find((doc) => doc.id === change.id)
    const applied = applyConversationChange(base, change)
    if (!applied) throw new Error(`Mudança sem base para ${change.id}: a tela devia ter mandado a conversa inteira.`)
    next = base ? next.map((doc) => (doc.id === change.id ? applied : doc)) : [...next, applied]
  }
  return next
}

/** `window.api.syncConversations` sobre uma chave do localStorage (o banco dos testes do App). */
export function syncIntoLocalStorage(key: string): (changes: ConversationChangeDto[]) => void {
  return (changes) => {
    const docs = JSON.parse(localStorage.getItem(key) || '[]') as Doc[]
    localStorage.setItem(key, JSON.stringify(applyChanges(docs, changes)))
  }
}

/** As mudanças entregues numa chamada de `syncConversations` (mock), por id. */
export function deliveredIds(calls: unknown[][]): string[] {
  return calls.flatMap((call) => (call[0] as ConversationChangeDto[]).map((change) => change.id))
}
