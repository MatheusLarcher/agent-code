export interface Archivable { id: string; updatedAt: number; archived?: boolean }

/** true apenas quando `archived === true`. */
export function isArchived(c: Archivable): boolean {
  return c.archived ?? false
}

/** Separa a lista em visíveis e arquivadas, preservando a ordem original nas duas. */
export function partitionArchived<T extends Archivable>(list: T[]): { visible: T[]; archived: T[] } {
  const visible: T[] = []
  const archived: T[] = []
  for (const c of list) {
    if (isArchived(c)) archived.push(c)
    else visible.push(c)
  }
  return { visible, archived }
}

/** Nova lista com o item `id` marcado/desmarcado. Imutável: não altera a lista
 *  nem os objetos recebidos. `id` inexistente → lista equivalente, sem mudanças. */
export function setArchived<T extends Archivable>(list: T[], id: string, archived: boolean): T[] {
  const next = [...list]
  for (let i = 0; i < next.length; i++) {
    if (next[i].id === id) {
      next[i] = { ...next[i], archived }
      break
    }
  }
  return next
}

/** Id da primeira conversa NÃO arquivada da lista, ou null se não houver. */
export function firstVisibleId<T extends Archivable>(list: T[]): string | null {
  for (const c of list) if (!isArchived(c)) return c.id
  return null
}

/** Ao arquivar `id`, qual conversa deve ficar ativa: a próxima não arquivada
 *  DEPOIS dele na lista; se não houver, a não arquivada mais próxima ANTES dele;
 *  se não sobrar nenhuma, null. Recebe a lista como está ANTES de arquivar. */
export function nextActiveAfterArchive<T extends Archivable>(list: T[], id: string): string | null {
  const i = list.findIndex((c) => c.id === id)
  if (i < 0) return null
  for (let j = i + 1; j < list.length; j++) {
    if (!isArchived(list[j])) return list[j].id
  }
  for (let j = i - 1; j >= 0; j--) {
    if (!isArchived(list[j])) return list[j].id
  }
  return null
}
