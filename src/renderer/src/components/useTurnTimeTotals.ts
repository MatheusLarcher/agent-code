import { useEffect, useState } from 'react'
import type { TurnTimeTotals } from '@shared/ipc'

/**
 * O tempo somado dos turnos da conversa (`conversation_turn_time`). Relido ao trocar
 * de conversa e quando o turno começa ou termina (`busy`): o total passa a incluir
 * a tarefa que acabou de fechar. `null` até a primeira leitura.
 */
export function useTurnTimeTotals(convId: string | null, busy: boolean): TurnTimeTotals | null {
  const [loaded, setLoaded] = useState<{ convId: string; time: TurnTimeTotals } | null>(null)
  useEffect(() => {
    if (!convId) return
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.getTurnTimeTotals !== 'function') return
    let cancelled = false
    void api.getTurnTimeTotals(convId).then(
      (time) => {
        if (!cancelled && time) setLoaded({ convId, time })
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [convId, busy])
  return loaded && loaded.convId === convId ? loaded.time : null
}
