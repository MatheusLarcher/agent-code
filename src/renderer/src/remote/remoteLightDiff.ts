/**
 * O que mudou desde a última publicação para o celular, por IDENTIDADE (como o
 * autosave): a conversa, o ocupado/conectado, a fila de espera, a permissão, o
 * travado e a Central. Nada percorre mensagens — o estado leve de uma conversa
 * só é remontado quando uma dessas peças mudou.
 */

export interface RemoteLightInputs<C extends { id: string }> {
  conv: C
  busy: boolean
  connected: boolean
  /** Chave da fila de espera da conversa (ids na ordem). */
  queued: string
  permission: unknown
  stalled: number | undefined
  /** O retrato da Central (só nela; null nas outras). */
  central: unknown
}

const same = <C extends { id: string }>(a: RemoteLightInputs<C>, b: RemoteLightInputs<C>): boolean =>
  a.conv === b.conv &&
  a.busy === b.busy &&
  a.connected === b.connected &&
  a.queued === b.queued &&
  a.permission === b.permission &&
  a.stalled === b.stalled &&
  a.central === b.central

export class RemoteLightDiff<C extends { id: string }> {
  private last = new Map<string, RemoteLightInputs<C>>()

  /** As conversas que mudaram (todas com `all`, o celular acabou de conectar) e as que saíram. */
  diff(items: Iterable<RemoteLightInputs<C>>, all: boolean): { changed: RemoteLightInputs<C>[]; removed: string[] } {
    const changed: RemoteLightInputs<C>[] = []
    const seen = new Set<string>()
    for (const item of items) {
      seen.add(item.conv.id)
      const previous = this.last.get(item.conv.id)
      if (all || !previous || !same(previous, item)) changed.push(item)
      this.last.set(item.conv.id, item)
    }
    const removed: string[] = []
    for (const id of this.last.keys()) {
      if (seen.has(id)) continue
      this.last.delete(id)
      removed.push(id)
    }
    return { changed, removed: all ? [] : removed }
  }
}
