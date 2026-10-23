/**
 * O que mudou desde a última publicação para o celular, por IDENTIDADE (como o
 * autosave): a conversa, o ocupado/conectado, a fila de espera, a permissão, o
 * travado e a Central. Nada percorre mensagens — o estado leve de uma conversa
 * só é remontado quando uma dessas peças mudou.
 */
import type { ApiRetryState } from '@shared/apiRetry'

export interface RemoteLightInputs<C extends { id: string }> {
  conv: C
  busy: boolean
  connected: boolean
  /** Chave da fila de espera da conversa (ids na ordem). */
  queued: string
  permission: unknown
  stalled: number | undefined
  /** Início da compactação em curso (epoch ms), ou undefined. */
  compacting?: number
  /** Nova tentativa da API agendada (cada evento traz um objeto novo), ou undefined. */
  apiRetry?: ApiRetryState
  /** Sugestão do próximo prompt (o chip), ou undefined. */
  suggestion?: string
  /** Chave dos subagentes rodando (remoteSubagentsKey: ids, rótulos e resumos). */
  subagents?: string
  /** O retrato da Central (só nela; null nas outras). */
  central: unknown
  /** Modelo/esforço que valem fora da conversa (no Agent Manager, a config dele). */
  modelKey?: string
}

const same = <C extends { id: string }>(a: RemoteLightInputs<C>, b: RemoteLightInputs<C>): boolean =>
  a.conv === b.conv &&
  a.modelKey === b.modelKey &&
  a.busy === b.busy &&
  a.connected === b.connected &&
  a.queued === b.queued &&
  a.permission === b.permission &&
  a.stalled === b.stalled &&
  a.compacting === b.compacting &&
  a.apiRetry === b.apiRetry &&
  a.suggestion === b.suggestion &&
  (a.subagents ?? '') === (b.subagents ?? '') &&
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

  /** A próxima publicação manda esta conversa de novo, mesmo sem mudança (o celular
   *  pediu algo que foi recusado e o main já ecoou o pedido no instantâneo dele). */
  invalidate(id: string): void {
    this.last.delete(id)
  }
}
