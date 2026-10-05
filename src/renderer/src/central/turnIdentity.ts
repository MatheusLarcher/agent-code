/**
 * A identidade do turno no renderer (contrato: `turnIds` em shared/ipc.ts — os
 * `messageUuid` que o App mandou ao main, como o CLI os devolve). Diz de QUAL turno
 * é um evento, para o terminal atrasado de um turno parado nunca ser tomado pelo
 * turno que saiu depois dele — e o terminal do turno corrente nunca ser engolido.
 *
 * - `current`: do turno em voo (o `sdkUuid` dele, ou um id que ele já mostrou).
 * - `stopped`: de um turno parado, sem outro turno em voo — é o fim dele.
 * - `stale`: de um turno parado COM outro turno em voo, ou de um turno que já
 *   acabou (`finish`): não é deste; fica fora do estado dele (só tokens e custo
 *   entram na conta da conversa).
 * - `unknown`: sem id (main/CLI antigo, evento da sessão): o caminho de sempre.
 *
 * Id que ninguém conhece, com um turno em voo, é desse turno (a continuação da troca
 * de provedor, um re-run do CLI): ele passa a responder também por esse id. Com o
 * turno em voo já parado, o id novo é do turno parado.
 */
export type TurnOwner = 'current' | 'stopped' | 'stale' | 'unknown'

/** O turno em voo de uma conversa, como o App o guarda (`inflightRef`). */
export interface TurnInflight {
  sdkUuid: string
  /** Outros ids que este turno mostrou (aprendidos aqui). */
  turnIds?: string[]
}

export interface TurnIdentity {
  /** Stop do turno em voo (comum ou o que mantém a fila): os ids dele passam a ser de turno parado. */
  stop(cid: string, inflight: TurnInflight | undefined): void
  /** O turno acabou (o terminal dele foi tratado): um 2º terminal atrasado com
   *  os ids dele é `stale` — não é do turno que sai depois. */
  finish(cid: string, inflight: TurnInflight | undefined): void
  /** Todos estes ids são de turnos que já acabaram (`finish`)? */
  finished(cid: string, ids: readonly string[] | undefined): boolean
  /** De quem é um evento com estes `turnIds`. */
  owner(cid: string, ids: readonly string[] | undefined, inflight: TurnInflight | undefined): TurnOwner
  /** Conversa apagada. */
  forget(cid: string): void
}

/** Quantos ids parados (e aprendidos) cada conversa guarda: só os recentes importam. */
const KEEP = 64

export function createTurnIdentity(): TurnIdentity {
  const stopped = new Map<string, string[]>()
  const isStopped = (cid: string, id: string): boolean => stopped.get(cid)?.includes(id) ?? false
  const markStopped = (cid: string, ids: readonly string[]): void => {
    const list = stopped.get(cid) ?? []
    for (const id of ids) if (!list.includes(id)) list.push(id)
    stopped.set(cid, list.slice(-KEEP))
  }
  const own = (turn: TurnInflight): string[] => [turn.sdkUuid, ...(turn.turnIds ?? [])]
  const ended = new Map<string, string[]>()
  const allEnded = (cid: string, ids: readonly string[] | undefined): boolean => {
    const list = ended.get(cid)
    return !!ids && ids.length > 0 && !!list && ids.every((id) => list.includes(id))
  }

  return {
    stop(cid, inflight) {
      if (inflight) markStopped(cid, own(inflight))
    },
    finish(cid, inflight) {
      if (!inflight) return
      const list = ended.get(cid) ?? []
      for (const id of own(inflight)) if (!list.includes(id)) list.push(id)
      ended.set(cid, list.slice(-KEEP))
    },
    finished: allEnded,
    owner(cid, ids, inflight) {
      if (!ids || ids.length === 0) return 'unknown'
      const live = inflight && !isStopped(cid, inflight.sdkUuid) ? inflight : undefined
      // Primeiro o turno corrente: um turno que juntou a mensagem parada e a nova
      // (o CLI dobra a fila num turno só) é da nova — nunca é descartado.
      if (live && ids.some((id) => own(live).includes(id))) return 'current'
      if (ids.some((id) => isStopped(cid, id))) return live ? 'stale' : 'stopped'
      // Rabo de um turno que já acabou (o `error` do fim do stream depois do
      // `result`): nunca é adotado pelo turno seguinte.
      if (allEnded(cid, ids)) return 'stale'
      if (!inflight) return 'unknown'
      if (live) {
        live.turnIds = [...(live.turnIds ?? []), ...ids.filter((id) => !own(live).includes(id))].slice(-KEEP)
        return 'current'
      }
      markStopped(cid, ids)
      return 'stopped'
    },
    forget(cid) {
      stopped.delete(cid)
      ended.delete(cid)
    }
  }
}

/** O `result` descartado ainda gastou: soma no total da conversa, sem tocar no
 *  contexto nem no "último turno" (que são do turno corrente). */
export function withStaleUsage<C extends { tokens: { output: number; cost: number } }>(
  conv: C,
  result: { usage?: { output: number }; costUsd?: number }
): C {
  const output = result.usage?.output ?? 0
  const cost = result.costUsd ?? 0
  if (output === 0 && cost === 0) return conv
  return { ...conv, tokens: { ...conv.tokens, output: conv.tokens.output + output, cost: conv.tokens.cost + cost } }
}
