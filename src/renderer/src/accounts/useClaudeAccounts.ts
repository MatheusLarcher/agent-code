import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeAccountView } from '@shared/claudeAccounts'

/** Menor intervalo entre duas releituras da lista disparadas por evento. */
const REFRESH_THROTTLE_MS = 10_000

/**
 * A lista de contas Claude no renderer (ordem do usuário, status, última
 * leitura). Lê do main — que só lê arquivos e o store, sem consultar consumo —
 * ao montar, quando pedido e, no máximo a cada 10 s, quando o consumo muda.
 */
export function useClaudeAccounts(): {
  accounts: ClaudeAccountView[]
  refresh: () => void
  refreshSoon: () => void
} {
  const [accounts, setAccounts] = useState<ClaudeAccountView[]>([])
  const lastRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = useCallback((): void => {
    lastRef.current = Date.now()
    void window.api
      .claudeAccountsList?.()
      .then((list) => setAccounts(Array.isArray(list) ? list : []))
      .catch(() => undefined)
  }, [])

  const refreshSoon = useCallback((): void => {
    if (timerRef.current) return
    const wait = Math.max(0, REFRESH_THROTTLE_MS - (Date.now() - lastRef.current))
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      refresh()
    }, wait)
  }, [refresh])

  useEffect(() => {
    refresh()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [refresh])

  return { accounts, refresh, refreshSoon }
}
