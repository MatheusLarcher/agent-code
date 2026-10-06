import { useEffect, useMemo, useState } from 'react'
import type { TokenUsageHistory } from '@shared/ipc'
import type { UsageMap } from '../tokenUsageTree'
import { usageTotals, type UsageTotals } from '../tokenUsageHistory'

const EMPTY: TokenUsageHistory = { calls: [], totals: [] }

/**
 * O consumo da conversa: o histórico do banco (lido uma vez por conversa, sem
 * `window.api` ou com falha, vale só o ao vivo) mais as chamadas ao vivo, sem
 * contar duas vezes (usageTotals). O ao vivo atualiza a cada chamada ao modelo.
 */
export function useTokenUsageTotals(convId: string | null, live: UsageMap): UsageTotals {
  const [loaded, setLoaded] = useState<{ convId: string | null; history: TokenUsageHistory }>({ convId: null, history: EMPTY })
  useEffect(() => {
    if (!convId) return
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (typeof api?.getTokenUsageHistory !== 'function') return
    let cancelled = false
    void api.getTokenUsageHistory(convId).then(
      (history) => {
        if (!cancelled && history) setLoaded({ convId, history })
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [convId])
  // O histórico de outra conversa não conta.
  const history = loaded.convId === convId ? loaded.history : EMPTY
  return useMemo(() => usageTotals(history, live), [history, live])
}
