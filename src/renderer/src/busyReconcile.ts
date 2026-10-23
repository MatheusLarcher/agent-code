/**
 * Rede de segurança do "trabalhando": a tela liga a ocupação por vários caminhos
 * (envio, fila, retomada, Stop que mantém a fila…) e só a desliga quando um deles
 * fecha. Se um terminal se perde ou um caminho não fecha, a conversa fica
 * "trabalhando" para sempre com o main parado — e o usuário só destrava com Stop.
 *
 * Aqui a tela confere com quem sabe: conversa ocupada e muda há QUIET_MS, sem
 * nada esperando o usuário, pergunta ao main se o turno acabou (`waitTurnEnd`).
 * Duas confirmações seguidas de "ocioso", sem evento nenhum no meio, soltam a
 * conversa pelo caminho normal (`release`). Um turno de verdade nunca é solto: o
 * main responde `timeout` enquanto ele roda, e qualquer evento zera a contagem.
 */
export const BUSY_RECONCILE_QUIET_MS = 45_000
export const BUSY_RECONCILE_POLL_MS = 15_000
/** Confirmações de "ocioso" seguidas, em rodadas distintas, antes de soltar. */
export const BUSY_RECONCILE_CONFIRMATIONS = 2

export interface BusyReconcileDeps {
  busyIds(): Iterable<string>
  /** Último evento do main para a conversa (qualquer tipo), em ms. */
  lastEventAt(cid: string): number | undefined
  /** Algo legítimo segura a ocupação: permissão/pergunta na tela, retomada,
   *  despacho da fila esperando, Stop em andamento, envio ainda não saiu. */
  blocked(cid: string): boolean
  /** `agent:wait-turn-end`; `settled` = o main está ocioso (ou sem sessão). */
  waitTurnEnd(cid: string): Promise<{ settled: boolean } | undefined> | undefined
  release(cid: string): void
  now(): number
}

export interface BusyReconcile {
  tick(): Promise<void>
}

export function createBusyReconcile(deps: BusyReconcileDeps): BusyReconcile {
  /** Desde quando a rodada vê a conversa ocupada (cobre a que nunca recebeu evento). */
  const seenBusySince = new Map<string, number>()
  const confirmations = new Map<string, number>()
  const checking = new Set<string>()

  const check = async (cid: string): Promise<void> => {
    const mark = deps.lastEventAt(cid)
    let idle = false
    try {
      idle = (await deps.waitTurnEnd(cid))?.settled === true
    } catch {
      idle = false
    }
    const stillSilent = deps.lastEventAt(cid) === mark
    const stillBusy = [...deps.busyIds()].includes(cid)
    if (!idle || !stillSilent || !stillBusy || deps.blocked(cid)) {
      confirmations.delete(cid)
      return
    }
    const count = (confirmations.get(cid) ?? 0) + 1
    if (count < BUSY_RECONCILE_CONFIRMATIONS) {
      confirmations.set(cid, count)
      return
    }
    confirmations.delete(cid)
    seenBusySince.delete(cid)
    deps.release(cid)
  }

  return {
    async tick() {
      const now = deps.now()
      const busy = new Set(deps.busyIds())
      for (const cid of [...seenBusySince.keys()]) {
        if (!busy.has(cid)) {
          seenBusySince.delete(cid)
          confirmations.delete(cid)
        }
      }
      const runs: Promise<void>[] = []
      for (const cid of busy) {
        if (!seenBusySince.has(cid)) seenBusySince.set(cid, now)
        const quietSince = Math.max(seenBusySince.get(cid) ?? now, deps.lastEventAt(cid) ?? 0)
        if (now - quietSince < BUSY_RECONCILE_QUIET_MS || deps.blocked(cid)) {
          confirmations.delete(cid)
          continue
        }
        if (checking.has(cid)) continue
        checking.add(cid)
        runs.push(check(cid).finally(() => checking.delete(cid)))
      }
      await Promise.all(runs)
    }
  }
}
