import { useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import { currentEnvio, type HandoffEnvio } from '@shared/handoffTracking'

/**
 * Os envios de handoff de UMA conversa, lidos do banco (handoff:list) e relidos
 * a cada aviso handoff:changed DAQUELA conversa — e, enquanto o envio corrente
 * está em execução, a cada minuto (o tracker grava a fatia de tempo ativo a cada
 * passada da varredura; o aviso dela já relê, o intervalo é a rede de segurança).
 *
 * Nada aqui vem do texto do modelo: é o que o app mediu e gravou.
 */

export type HandoffEnviosApi = Pick<AgentCodeApi, 'handoffList' | 'onHandoffChanged'>

/** Releitura periódica enquanto o envio corrente está em execução. */
export const HANDOFF_REFRESH_MS = 60_000

export interface HandoffEnviosState {
  /** `null` = ainda não houve leitura que deu certo. */
  envios: HandoffEnvio[] | null
  /** A última leitura falhou (banco fora do ar, app sem o canal). */
  error: string | null
}

const NO_API = 'o app não expõe a leitura dos envios (handoff:list)'

/** O `window.api` do preload, se ele tiver os dois canais (testes antigos e
 *  versões sem o acompanhamento não têm). */
function windowApi(): HandoffEnviosApi | null {
  const api = (window as unknown as { api?: Partial<AgentCodeApi> }).api
  return api && typeof api.handoffList === 'function' && typeof api.onHandoffChanged === 'function'
    ? (api as HandoffEnviosApi)
    : null
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useHandoffEnvios(
  conversationId: string | null,
  options: { api?: HandoffEnviosApi; refreshMs?: number } = {}
): HandoffEnviosState {
  // Em ref: um objeto novo a cada render (teste, chamador) não pode reassinar o aviso.
  const apiRef = useRef(options.api)
  apiRef.current = options.api
  const loadRef = useRef<(() => Promise<void>) | null>(null)
  const [state, setState] = useState<HandoffEnviosState & { conv: string | null }>({ conv: null, envios: null, error: null })

  useEffect(() => {
    loadRef.current = null
    if (!conversationId) return
    const api = apiRef.current ?? windowApi()
    if (!api) {
      setState({ conv: conversationId, envios: null, error: NO_API })
      return
    }
    let alive = true
    let seq = 0
    const fail = (message: string): void =>
      // Uma falha não apaga o que já se leu desta conversa: a tela mostra o último dado.
      setState((prev) => ({ conv: conversationId, envios: prev.conv === conversationId ? prev.envios : null, error: message }))
    const load = async (): Promise<void> => {
      const mine = ++seq
      try {
        const res = await api.handoffList({ conversationId })
        // Só a resposta mais recente vale (duas leituras podem se cruzar).
        if (!alive || mine !== seq) return
        if (res && res.ok === true) setState({ conv: conversationId, envios: res.envios, error: null })
        else fail(res && 'message' in res ? res.message : 'resposta inválida do processo principal')
      } catch (err) {
        if (alive && mine === seq) fail(errText(err))
      }
    }
    loadRef.current = load
    void load()
    let off: (() => void) | undefined
    try {
      off = api.onHandoffChanged((msg) => {
        if (msg?.conversationId === conversationId) void load()
      })
    } catch (err) {
      fail(errText(err))
    }
    return () => {
      alive = false
      loadRef.current = null
      off?.()
    }
  }, [conversationId])

  const mine = state.conv === conversationId
  const running = mine && currentEnvio(state.envios ?? [])?.status === 'em_execucao'
  const refreshMs = options.refreshMs ?? HANDOFF_REFRESH_MS
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void loadRef.current?.(), refreshMs)
    return () => clearInterval(timer)
  }, [running, refreshMs, conversationId])

  return mine ? { envios: state.envios, error: state.error } : { envios: null, error: null }
}
