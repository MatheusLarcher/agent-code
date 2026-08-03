/**
 * Regras de "conversa arquivada", em funções puras compartilhadas: a barra lateral
 * decide o que mostrar e o App decide quem fica ativo a partir daqui — nenhuma das
 * duas reimplementa o filtro, que é onde arquivada acabaria reaparecendo em um
 * lugar e sumindo no outro.
 */

export interface Archivable {
  id: string
  updatedAt: number
  archived?: boolean
}

/** Só o `true` explícito arquiva — `undefined` é o estado normal de toda conversa
 *  criada antes deste recurso existir. */
export function isArchived(c: Archivable): boolean {
  return c.archived === true
}

/** Divide mantendo a ordem original nas duas listas (a barra lateral já vem
 *  ordenada por atividade e não pode se reordenar ao arquivar alguém). */
export function partitionArchived<T extends Archivable>(list: T[]): { visible: T[]; archived: T[] } {
  const visible: T[] = []
  const archived: T[] = []
  for (const item of list) {
    if (isArchived(item)) archived.push(item)
    else visible.push(item)
  }
  return { visible, archived }
}

/** Cópia da lista com um item marcado/desmarcado. Imutável de propósito: o estado
 *  do React compara por referência, e mutar o objeto no lugar não repintaria. */
export function setArchived<T extends Archivable>(list: T[], id: string, archived: boolean): T[] {
  return list.map((item) => (item.id === id ? { ...item, archived } : item))
}

/** Primeira conversa que o usuário realmente pode ver. */
export function firstVisibleId<T extends Archivable>(list: T[]): string | null {
  return list.find((item) => !isArchived(item))?.id ?? null
}

/**
 * Quem assume o lugar quando `id` é arquivado. Olha primeiro para baixo (a
 * conversa seguinte é a continuação natural da leitura) e só então para cima;
 * `null` quando arquivar aquela esvazia a lista visível.
 */
export function nextActiveAfterArchive<T extends Archivable>(list: T[], id: string): string | null {
  const at = list.findIndex((item) => item.id === id)
  if (at < 0) return null
  for (let i = at + 1; i < list.length; i++) {
    if (!isArchived(list[i])) return list[i].id
  }
  for (let i = at - 1; i >= 0; i--) {
    if (!isArchived(list[i])) return list[i].id
  }
  return null
}
