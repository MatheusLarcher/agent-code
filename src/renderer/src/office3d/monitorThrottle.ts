/**
 * Cadência da tela do monitor: troca no máximo uma vez a cada `interval` ms,
 * com a ÚLTIMA sempre aparecendo (throttle com trailing).
 *
 *   offer(value, sig)   o valor mais novo e a assinatura dele; devolve o que a
 *                       tela mostra AGORA. Primeira oferta (ou passado o
 *                       intervalo desde a última troca): troca na hora. Dentro
 *                       do intervalo: guarda o mais novo e agenda UMA troca para
 *                       quando o intervalo vencer — `onLate(valor)` avisa quem
 *                       desenha. Mesma assinatura do que já está na tela: nada
 *                       muda (e a troca agendada, se havia, é cancelada).
 *   reset()             esquece o que mostrou e cancela a troca agendada (tela
 *                       apagou ou trocou de dono: a próxima oferta entra na hora).
 */

/** No máximo uma troca de conteúdo do monitor a cada isto. */
export const MONITOR_SWAP_MS = 2000

export interface SwapThrottle<T> {
  offer(value: T, sig: string): T
  reset(): void
}

export function createSwapThrottle<T>(onLate: (value: T) => void, interval = MONITOR_SWAP_MS, now: () => number = () => Date.now()): SwapThrottle<T> {
  let shown: { value: T; sig: string } | null = null
  let at = -Infinity
  let next: { value: T; sig: string } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    next = null
  }

  const flush = (): void => {
    timer = null
    const n = next
    next = null
    if (!n) return
    shown = n
    at = now()
    onLate(n.value)
  }

  return {
    offer(value, sig) {
      if (shown && sig === shown.sig) {
        cancel()
        return shown.value
      }
      const t = now()
      if (!shown || t - at >= interval) {
        cancel()
        shown = { value, sig }
        at = t
        return value
      }
      next = { value, sig }
      if (timer === null) timer = setTimeout(flush, Math.max(0, at + interval - t))
      return shown.value
    },
    reset() {
      cancel()
      shown = null
      at = -Infinity
    }
  }
}
