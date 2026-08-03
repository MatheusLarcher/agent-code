/**
 * Interface para qualquer objeto que possa ser arquivado.
 * Deve ter um ID, um timestamp de atualização e um status opcional de arquivamento.
 */
export interface Archivable {
  id: string
  updatedAt: number
  archived?: boolean
}

/**
 * Verifica se uma conversa está arquivada.
 * @param c A conversa a ser verificada.
 * @returns true se `archived` for true.
 */
export function isArchived(c: Archivable): boolean {
  return c.archived === true
}

/**
 * Separa uma lista de itens em visíveis e arquivados, preservando a ordem original em ambas as listas.
 * @param list A lista de itens a ser particionada.
 * @returns Um objeto contendo as listas `visible` e `archived`.
 */
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

/**
 * Cria uma nova lista com o item de ID especificado marcado/desmarcado.
 * Esta função é imutável: não altera a lista original nem os objetos recebidos.
 * @param list A lista original de itens.
 * @param id O ID do item a ser modificado.
 * @param archived O novo status de arquivamento (true ou false).
 * @returns Uma nova lista com o item atualizado, ou a lista original se o ID não for encontrado.
 */
export function setArchived<T extends Archivable>(list: T[], id: string, archived: boolean): T[] {
  const found = list.find(item => item.id === id)
  if (!found) {
    return list
  }

  return list.map(item =>
    item.id === id
      ? { ...item, archived: archived } as T
      : item
  )
}

/**
 * Retorna o ID da primeira conversa NÃO arquivada na lista.
 * @param list A lista de conversas.
 * @returns O ID da primeira conversa visível, ou null se todas estiverem arquivadas.
 */
export function firstVisibleId<T extends Archivable>(list: T[]): string | null {
  for (const item of list) {
    if (!isArchived(item)) {
      return item.id
    }
  }
  return null
}

/**
 * Determina qual conversa deve ficar ativa após arquivar um item específico.
 * A regra é:
 * 1. A próxima não arquivada DEPOIS do ID.
 * 2. Se não houver, a não arquivada mais próxima ANTES do ID.
 * 3. Se não sobrar nenhuma, null.
 * @param list A lista de conversas ANTES de arquivar.
 * @param id O ID da conversa que será arquivada.
 * @returns O ID da conversa que deve ser a próxima ativa, ou null.
 */
export function nextActiveAfterArchive<T extends Archivable>(list: T[], id: string): string | null {
  const targetIndex = list.findIndex(item => item.id === id)
  if (targetIndex === -1) {
    return null // ID não encontrado
  }

  // 1. Procurar para frente (depois)
  for (let i = targetIndex + 1; i < list.length; i++) {
    const item = list[i]
    if (!isArchived(item)) {
      return item.id
    }
  }

  // 2. Procurar para trás (antes)
  for (let i = targetIndex - 1; i >= 0; i--) {
    const item = list[i]
    if (!isArchived(item)) {
      return item.id
    }
  }

  // 3. Nenhuma conversa visível restante
  return null
}
