/**
 * Fiação do "Conectar conta" no App: estado dos provedores, espelho nos
 * sinalizadores que o seletor de modelos já usa (Codex/Ollama) e a troca de
 * modelo da conversa ativa depois de conectar.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { ProvidersStatus } from '@shared/ipc'
import type { Conversation } from '../../types'
import { modelAfterConnect, type ProviderId } from './providerModels'
import { useProvidersStatus } from './useProvidersStatus'

interface Deps {
  getActive: () => Conversation | null | undefined
  changeModel: (convId: string, model: string) => void
  setCodexReady: (ready: boolean) => void
  setOllamaReady: (ready: boolean) => void
}

export function useConnectAccount(deps: Deps): {
  status: ProvidersStatus | null
  statusRef: React.MutableRefObject<ProvidersStatus | null>
  onConnected: (provider: ProviderId) => void
} {
  const { status } = useProvidersStatus()
  const statusRef = useRef<ProvidersStatus | null>(null)
  statusRef.current = status
  const depsRef = useRef(deps)
  depsRef.current = deps

  // O seletor de modelos passa a oferecer os do provedor recém-conectado.
  useEffect(() => {
    if (!status) return
    depsRef.current.setCodexReady(status.gpt)
    depsRef.current.setOllamaReady(status.ollama)
  }, [status])

  const onConnected = useCallback((provider: ProviderId): void => {
    const { getActive, changeModel, setCodexReady, setOllamaReady } = depsRef.current
    if (provider === 'gpt') setCodexReady(true)
    if (provider === 'ollama') setOllamaReady(true)
    const active = getActive()
    if (!active) return
    const base = statusRef.current ?? { claude: false, gpt: false, ollama: false }
    const next = modelAfterConnect(active.model, { ...base, [provider]: true }, provider)
    if (next && next !== active.model) changeModel(active.id, next)
  }, [])

  return { status, statusRef, onConnected }
}
