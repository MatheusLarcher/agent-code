import type { OutboxEntryDto } from '@shared/ipc'

/**
 * A fila de espera das conversas gravada no banco (sobrevive ao reinício).
 *
 * O App mantém a fila em memória como sempre; aqui fica só a tradução para o
 * que vai ao banco e a decisão de QUAIS conversas regravar. Um único ponto de
 * sincronização (efeito sobre a fila) cobre todo caminho que mexe nela: envio
 * com o agente ocupado, drenagem no fim do turno, remover, "agora", Stop,
 * apagar a conversa.
 */

export interface OutboxItemLike {
  id: string
  convId: string
}

/** Conversas cuja fila mudou (conteúdo, ordem, ou esvaziou) desde a última gravação. */
export function changedConversations<T extends OutboxItemLike>(previous: readonly T[], next: readonly T[]): string[] {
  const fingerprint = (list: readonly T[]): Map<string, string> => {
    const map = new Map<string, string[]>()
    for (const item of list) map.set(item.convId, [...(map.get(item.convId) ?? []), item.id])
    return new Map([...map].map(([conv, ids]) => [conv, ids.join('|')]))
  }
  const before = fingerprint(previous)
  const after = fingerprint(next)
  const convs = new Set([...before.keys(), ...after.keys()])
  return [...convs].filter((conv) => before.get(conv) !== after.get(conv))
}

/** A fila de UMA conversa no formato do banco (o `convId` vai na chave, não no payload). */
export function outboxItemsFor<T extends OutboxItemLike>(queue: readonly T[], convId: string): Array<{ id: string; payload: Omit<T, 'convId' | 'id'> }> {
  return queue
    .filter((item) => item.convId === convId)
    .map(({ id, convId: _conv, ...payload }) => ({ id, payload }))
}

/** O que veio do banco de volta ao formato da fila. Entrada malformada é descartada. */
export function restoreOutbox<T extends OutboxItemLike>(
  entries: readonly OutboxEntryDto[],
  isPayload: (value: unknown) => value is Omit<T, 'convId' | 'id'>
): T[] {
  const out: T[] = []
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.conversationId !== 'string') continue
    if (!isPayload(entry.payload)) continue
    out.push({ ...entry.payload, id: entry.id, convId: entry.conversationId } as T)
  }
  return out
}
