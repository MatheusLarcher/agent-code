/**
 * O Stop que MANTÉM a fila — o "não era aqui" da Central com o turno rodando.
 *
 * A conversa fica "parando" (ocupada para todo despacho: tudo enfileira, o
 * "agora" espera) até o turno parado terminar de verdade. O main roda um turno
 * por vez (agentSession.ts, `drainPersistedInputs`): nada do turno seguinte chega
 * antes do terminal do turno parado — então o 1º terminal depois do Stop é dele.
 *
 * - `result`: espera uma carência curta pelo `error` do fim do stream (o iterador
 *   que lança depois do interrupt) e solta; o `error` solta na hora (depois dele
 *   a query morreu: nada mais vem).
 * - Fase no Stop: `unsent` — o envio nem saiu (ainda no connect): não há turno,
 *   não há terminal; solta no recibo. `started` — o turno já falou: o terminal
 *   vem com certeza; só ele solta (reserva longa, do último sinal de vida, só para
 *   nunca ficar ocupada para sempre). `unknown` — enviada e muda: o Stop pode ter
 *   pegado a mensagem antes de o turno começar (o SDK a descarta sem `result`);
 *   reserva curta contada do recibo; falar durante a espera a promove a `started`.
 *
 * Com identidade de turno (`turnIds`, central/turnIdentity.ts) o App sabe que o
 * terminal é do turno parado: solta na hora, sem carência — o `error` que vier
 * depois também traz o id e é descartado do turno seguinte. As reservas ficam só
 * para quando nenhum terminal vem (o SDK descartou a mensagem, o CLI não assentou)
 * — e o terminal que chegar depois delas também é reconhecido pelo id. A carência
 * e o terminal sem id seguem para main/CLI que não devolvem o id.
 *
 * Depois de soltar, NADA é engolido aqui: o terminal sem id seguinte é do turno que
 * saiu da fila (um limite de uso sem texto antes tem de aparecer como falha).
 */
export type StopPhase = 'unsent' | 'unknown' | 'started'

/** `wait`: era o `result` do turno parado — feche-o, mas a conversa segue parando
 *  (carência). `release`: era o terminal do turno parado — feche-o e solte a fila.
 *  `normal`: nada a ver com o Stop. */
export type StopTerminal = 'wait' | 'release' | 'normal'

/** Reserva quando a mensagem foi enviada e o turno não falou (contada do recibo do Stop). */
export const STOP_SETTLE_MS = 3000
/** Carência depois do `result` do turno parado, à espera do `error` do fim do stream. */
export const STOP_GRACE_MS = 500
/** Reserva quando o turno parado falou (o terminal dele vem): conta do último sinal de vida. */
export const STOP_SAFETY_MS = 30_000

export interface StopHolds {
  /** O Stop que mantém a fila foi pedido: a conversa passa a "parando". */
  begin(cid: string, phase: StopPhase): void
  /** A conversa está parando: despacho enfileira, "agora" e reenvio esperam. */
  isHeld(cid: string): boolean
  /** O recibo do Stop. Com mensagens que sobreviveram, o turno segue de verdade: a
   *  espera acaba sem soltar (o fim normal do turno entrega a fila). */
  receipt(cid: string, survivors: boolean): void
  /** Um terminal (`result`/`error`) da conversa chegou. `identified`: o id dele é o
   *  do turno parado (solta na hora); sem id, o turno parado é o único que roda. */
  terminal(cid: string, kind: 'result' | 'error', identified?: boolean): StopTerminal
  /** Saída do modelo (texto, pensamento, ferramenta). Parando, só o turno parado
   *  fala: ele começou de fato, e o terminal dele vem. */
  activity(cid: string): void
  /** Stop comum ou conversa apagada: esquece a espera, sem soltar. */
  cancel(cid: string): void
  /** Desmonte: nenhum prazo sobrevive. */
  dispose(): void
}

export interface StopHoldOptions {
  settleMs: number
  graceMs: number
  safetyMs: number
  /** Soltar a fila mantida (a conversa sai de "parando"). */
  onRelease: (cid: string) => void
}

type Timer = ReturnType<typeof setTimeout>

interface Hold {
  phase: StopPhase | 'grace'
  /** O recibo do Stop já chegou (as reservas só correm depois dele). */
  receipt: boolean
  timer?: Timer
}

export function createStopHolds(opts: StopHoldOptions): StopHolds {
  const held = new Map<string, Hold>()

  const clear = (cid: string): void => {
    const hold = held.get(cid)
    if (hold?.timer !== undefined) clearTimeout(hold.timer)
    held.delete(cid)
  }
  const release = (cid: string): void => {
    clear(cid)
    opts.onRelease(cid)
  }
  const arm = (cid: string, hold: Hold, ms: number): void => {
    if (hold.timer !== undefined) clearTimeout(hold.timer)
    hold.timer = setTimeout(() => {
      if (held.get(cid) === hold) release(cid)
    }, ms)
  }

  return {
    begin(cid, phase) {
      clear(cid)
      held.set(cid, { phase, receipt: false })
    },
    isHeld: (cid) => held.has(cid),
    receipt(cid, survivors) {
      const hold = held.get(cid)
      if (!hold) return
      if (survivors) return clear(cid)
      hold.receipt = true
      if (hold.phase === 'unsent') return release(cid)
      if (hold.phase === 'unknown') arm(cid, hold, opts.settleMs)
      else if (hold.phase === 'started') arm(cid, hold, opts.safetyMs)
      // 'grace': a carência do `result` já corre.
    },
    terminal(cid, kind, identified = false) {
      const hold = held.get(cid)
      if (!hold) return 'normal'
      if (identified || kind === 'error' || hold.phase === 'grace') {
        clear(cid)
        return 'release'
      }
      hold.phase = 'grace'
      arm(cid, hold, opts.graceMs)
      return 'wait'
    },
    activity(cid) {
      const hold = held.get(cid)
      if (!hold || hold.phase === 'grace' || hold.phase === 'unsent') return
      hold.phase = 'started'
      if (hold.receipt) arm(cid, hold, opts.safetyMs)
    },
    cancel(cid) {
      clear(cid)
    },
    dispose() {
      for (const hold of held.values()) if (hold.timer !== undefined) clearTimeout(hold.timer)
      held.clear()
    }
  }
}
