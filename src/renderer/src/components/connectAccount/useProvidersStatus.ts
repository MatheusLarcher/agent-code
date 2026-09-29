import { useCallback, useEffect, useState } from 'react'
import type { ProvidersStatus } from '@shared/ipc'

/** Estado dos provedores (Claude, GPT, Ollama): lido no início e atualizado a
 *  cada `providersChanged` do main. null até a primeira resposta. */
export function useProvidersStatus(): { status: ProvidersStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<ProvidersStatus | null>(null)
  const refresh = useCallback((): void => {
    void window.api.providersStatus().then(setStatus).catch(() => undefined)
  }, [])
  useEffect(() => {
    refresh()
    return window.api.onProvidersChanged(setStatus)
  }, [refresh])
  return { status, refresh }
}
