/**
 * A passagem da fila de uma conversa para o próximo item. O 1º evento terminal
 * (`result`/`error`) sai do main ANTES de o turno acabar de fato: a verificação
 * do espelho (handoff) e o lease solto vêm depois, e o fim do stream ainda pode
 * mandar um 2º terminal. O próximo item só sai quando o main confirma o fim real
 * (`agent:wait-turn-end`: ocioso + handoff + lease solto, sem sessão, ou o prazo).
 *
 * Enquanto a espera corre a conversa tem um despacho `pending`: o App trata um
 * terminal sem identidade que chega nessa janela como rabo do turno que acabou
 * (o turno novo ainda não saiu, então não pode ser dele).
 */
/** Prazo local da espera: maior que o do main (45 s), só para um IPC que não volta. */
export const QUEUE_HANDOFF_FALLBACK_MS = 60_000

export interface QueueHandoff {
  /** Roda `next` depois do fim real do turno anterior de `cid`. Falha ou ausência
   *  do sinal não trava a fila: segue igual (o main já tem prazo; aqui há outro). */
  after<T>(cid: string, next: () => T | Promise<T>): Promise<T>
  /** Há despacho da fila esperando o fim do turno anterior desta conversa. */
  pending(cid: string): boolean
}

export interface QueueHandoffDeps {
  /** O sinal do main (`window.api.waitTurnEnd`); ausente = segue na hora. */
  waitTurnEnd: (cid: string) => Promise<unknown> | undefined
  /** Prazo local, para um IPC que nunca responde (o do main é menor). */
  fallbackMs: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** Espera o fim real do turno de `cid` no main, com o prazo local. Nunca rejeita:
 *  sem o sinal (canal ausente, falha, IPC que não volta) segue igual. */
export async function waitForTurnEnd(deps: QueueHandoffDeps, cid: string): Promise<void> {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let handle: unknown
  try {
    const signal = deps.waitTurnEnd(cid)
    if (!signal) return
    await Promise.race([
      signal,
      new Promise<void>((resolve) => {
        handle = setTimer(resolve, deps.fallbackMs)
      })
    ])
  } catch {
    // Sem o sinal a fila não para: o pior caso é o comportamento de antes.
  } finally {
    if (handle !== undefined) clearTimer(handle)
  }
}

export function createQueueHandoff(deps: QueueHandoffDeps): QueueHandoff {
  const waiting = new Map<string, number>()

  return {
    async after(cid, next) {
      waiting.set(cid, (waiting.get(cid) ?? 0) + 1)
      try {
        await waitForTurnEnd(deps, cid)
      } finally {
        const left = (waiting.get(cid) ?? 1) - 1
        if (left > 0) waiting.set(cid, left)
        else waiting.delete(cid)
      }
      return next()
    },
    pending(cid) {
      return (waiting.get(cid) ?? 0) > 0
    }
  }
}
