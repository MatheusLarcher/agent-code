export interface Registro {
  id: string
  updatedAt: number
  /** Quanto do registro está preenchido; usado só para desempate. */
  messages?: unknown[]
}

/** Empate no `updatedAt` cai para quem tem mais mensagens — o registro mais
 *  completo é o que menos perde dado quando um lado sobrescreve o outro. */
function maisCompleto(candidato: Registro, atual: Registro): boolean {
  if (candidato.updatedAt !== atual.updatedAt) return candidato.updatedAt > atual.updatedAt
  return (candidato.messages?.length ?? 0) > (atual.messages?.length ?? 0)
}

/**
 * Junta `local` e `remoto` numa lista só, sem duplicar por `id`.
 *
 * A ordem é a da primeira aparição (local inteiro, depois remoto) e não a do
 * vencedor: quando o remoto ganha o conflito, ele assume o lugar que o registro
 * já ocupava — senão a lista se reordenaria sozinha a cada sincronização.
 * Empate absoluto fica com o `local`: na dúvida, não mexe no que já está aqui.
 */
export function reconcile<T extends Registro>(local: T[], remoto: T[]): T[] {
  const posicao = new Map<string, number>()
  const saida: T[] = []

  for (const registro of [...local, ...remoto]) {
    if (!registro?.id) continue // sem id não há como reconciliar: descarta
    const at = posicao.get(registro.id)
    if (at === undefined) {
      posicao.set(registro.id, saida.length)
      saida.push(registro)
      continue
    }
    if (maisCompleto(registro, saida[at])) saida[at] = registro
  }

  return saida
}
