import { useCallback, useEffect, useState } from 'react'
import type { ProvidersStatus } from '@shared/ipc'

const RECHECK_MS = 20_000

/** Estado dos provedores (Claude, GPT, Ollama): lido no início e atualizado a
 *  cada `providersChanged` do main. null até a primeira resposta. Enquanto
 *  nenhum aparece conectado, reconsulta de tempos em tempos e ao voltar o foco
 *  — uma checagem que falhou (ex.: CLI lento no 1º uso) não prende o card. */
export function useProvidersStatus(): { status: ProvidersStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<ProvidersStatus | null>(null)
  const refresh = useCallback((): void => {
    void window.api.providersStatus().then(setStatus).catch(() => undefined)
  }, [])
  useEffect(() => {
    refresh()
    return window.api.onProvidersChanged(setStatus)
  }, [refresh])
  const noneConnected = !!status && !status.claude && !status.gpt && !status.ollama
  useEffect(() => {
    if (!noneConnected) return
    const timer = window.setInterval(refresh, RECHECK_MS)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [noneConnected, refresh])
  return { status, refresh }
}
