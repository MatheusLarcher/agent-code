/**
 * Utilitários imutáveis para marcar/desmarcar conversas como arquivadas.
 *
 * Conversa arquivada não aparece na lista de projetos nem em "Chats" — fica
 * numa seção própria na sidebar, com botão para desarquivar. O campo `archived`
 * é salvo no `projectStore` e sobrevive a reinícios do app.
 */

export interface Archivable { id: string; updatedAt: number; archived?: boolean }

/** true apenas quando `archived === true`. */
export function isArchived(c: Archivable): boolean {
  return c.archived === true
}

/** Separa a lista em visíveis e arquivadas, preservando a ordem original nas duas. */
export function partitionArchived<T extends Archivable>(list: T[]): { visible: T[]; archived: T[] } {
  const visible: T[] = []
  const archived: T[] = []
  for (const c of list) {
    if (isArchived(c)) {
      archived.push(c)
    } else {
      visible.push(c)
    }
  }
  return { visible, archived }
}

/** Nova lista com o item `id` marcado/desmarcado. Imutável: não altera a lista
 *  nem os objetos recebidos. `id` inexistente → lista equivalente, sem mudanças. */
export function setArchived<T extends Archivable>(list: T[], id: string, archived: boolean): T[] {
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return list
  const copy = [...list]
  copy[idx] = { ...copy[idx], archived }
  return copy
}

/** Id da primeira conversa NÃO arquivada da lista, ou null se não houver. */
export function firstVisibleId<T extends Archivable>(list: T[]): string | null {
  for (const c of list) {
    if (!isArchived(c)) return c.id
  }
  return null
}

/** Ao arquivar `id`, qual conversa deve ficar ativa: a próxima não arquivada
 *  DEPOIS dele na lista; se não houver, a não arquivada mais próxima ANTES dele;
 *  se não sobrar nenhuma, null. Recebe a lista como está ANTES de arquivar. */
export function nextActiveAfterArchive<T extends Archivable>(list: T[], id: string): string | null {
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return null
  // Tenta a próxima não arquivada (depois dele na lista).
  for (let i = idx + 1; i < list.length; i++) {
    if (!isArchived(list[i])) return list[i].id
  }
  // Se não tem mais depois, volta para a última não arquivada ANTES dele.
  for (let i = idx - 1; i >= 0; i--) {
    if (!isArchived(list[i])) return list[i].id
  }
  return null
}
