export interface Archivable { id: string; updatedAt: number; archived?: boolean }

/** true apenas quando `archived === true`. */
export function isArchived(c: Archivable): boolean {
  return c.archived === true
}

/** Separa a lista em visíveis e arquivadas, preservando a ordem original nas duas. */
export function partitionArchived<T extends Archivable>(list: T[]): { visible: T[]; archived: T[] } {
  const visible: T[] = []
  const archived: T[] = []
  for (const item of list) {
    if (isArchived(item)) {
      archived.push(item)
    } else {
      visible.push(item)
    }
  }
  return { visible, archived }
}

/** Nova lista com o item `id` marcado/desmarcado. Imutável: não altera a lista
 *  nem os objetos recebidos. `id` inexistente → lista equivalente, sem mudanças. */
export function setArchived<T extends Archivable>(list: T[], id: string, archived: boolean): T[] {
  return list.map((item) => (item.id === id ? { ...item, archived } : item))
}

/** Id da primeira conversa NÃO arquivada da lista, ou null se não houver. */
export function firstVisibleId<T extends Archivable>(list: T[]): string | null {
  for (const item of list) {
    if (!isArchived(item)) return item.id
  }
  return null
}

/** Ao arquivar `id`, qual conversa deve ficar ativa: a próxima não arquivada
 *  DEPOIS dele na lista; se não houver, a não arquivada mais próxima ANTES dele;
 *  se não sobrar nenhuma, null. Recebe a lista como está ANTES de arquivar. */
export function nextActiveAfterArchive<T extends Archivable>(list: T[], id: string): string | null {
  const idx = list.findIndex((item) => item.id === id)
  if (idx === -1) return null

  // Prioriza a próxima conversa visível após o arquivamento para manter o fluxo de trabalho.
  for (let i = idx + 1; i < list.length; i++) {
    if (!isArchived(list[i])) return list[i].id
  }
  // Caso não haja sucessor, retrocede para o predecessor mais próximo.
  for (let i = idx - 1; i >= 0; i--) {
    if (!isArchived(list[i])) return list[i].id
  }
  return null
}
