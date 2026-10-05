import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { HANDOFF_REFRESH_MS } from '../handoffTracking/useHandoffEnvios'
import { ipcErrorMessage } from '../ipcError'

/**
 * TODOS os envios de handoff, de todos os projetos, lidos do banco
 * (handoff:list sem filtro) e relidos a cada handoff:changed de QUALQUER
 * conversa — avisos em rajada viram uma releitura só depois da que está no ar.
 * Enquanto algum envio está em execução, relê também a cada minuto (a rede de
 * segurança do tempo ativo, como no indicador de prazo).
 *
 * Uma leitura só alimenta o contador da barra, a tela Entregas e os toasts.
 */

export type DeliveriesApi = Pick<AgentCodeApi, 'handoffList' | 'onHandoffChanged' | 'handoffCorrectEntrega'>

/** O teto do handoff:list: a tela quer todos. */
export const DELIVERIES_LIMIT = 1000

export type CorrectionResult = { ok: true; envio: HandoffEnvio } | { ok: false; message: string }

export interface DeliveriesState {
  /** `null` = ainda não houve leitura que deu certo. */
  envios: HandoffEnvio[] | null
  /** A última leitura falhou (banco fora do ar, app sem o canal). */
  error: string | null
  /** Relê agora (ao abrir a tela). */
  refresh: () => void
  /** Correção manual de uma entrega (handoff:correctEntrega); o envio devolvido entra na lista. */
  correct: (entregaId: string, acao: 'concluir' | 'reabrir') => Promise<CorrectionResult>
}

const NO_API = 'o app não expõe a leitura dos envios (handoff:list)'

/** O `window.api` do preload, se ele tiver os canais de leitura (testes antigos não têm). */
function windowApi(): DeliveriesApi | null {
  const api = (window as unknown as { api?: Partial<AgentCodeApi> }).api
  return api && typeof api.handoffList === 'function' && typeof api.onHandoffChanged === 'function'
    ? (api as DeliveriesApi)
    : null
}

export function useDeliveries(options: { api?: DeliveriesApi; refreshMs?: number } = {}): DeliveriesState {
  // Em ref: um objeto novo a cada render não pode reassinar o aviso.
  const apiRef = useRef(options.api)
  apiRef.current = options.api
  const [data, setData] = useState<{ envios: HandoffEnvio[] | null; error: string | null }>({ envios: null, error: null })
  const alive = useRef(true)
  const busy = useRef(false)
  const again = useRef(false)

  const api = useCallback((): DeliveriesApi | null => apiRef.current ?? windowApi(), [])

  const load = useCallback(async (): Promise<void> => {
    const a = api()
    if (!a) return
    // Uma leitura no ar: a próxima sai quando ela voltar (uma só, por mais avisos que cheguem).
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    try {
      do {
        again.current = false
        try {
          const res = await a.handoffList({ limit: DELIVERIES_LIMIT })
          if (!alive.current) return
          if (res && res.ok === true) setData({ envios: res.envios, error: null })
          // Uma falha não apaga o que já se leu: a tela mostra o último dado.
          else setData((prev) => ({ envios: prev.envios, error: res && 'message' in res ? res.message : 'resposta inválida do processo principal' }))
        } catch (err) {
          if (!alive.current) return
          setData((prev) => ({ envios: prev.envios, error: ipcErrorMessage(err, 'falha ao ler os envios') }))
        }
      } while (again.current)
    } finally {
      busy.current = false
    }
  }, [api])

  useEffect(() => {
    alive.current = true
    const a = api()
    if (!a) {
      setData({ envios: null, error: NO_API })
      return
    }
    void load()
    let off: (() => void) | undefined
    try {
      off = a.onHandoffChanged(() => void load())
    } catch (err) {
      setData((prev) => ({ envios: prev.envios, error: ipcErrorMessage(err, 'falha ao assinar os avisos dos envios') }))
    }
    return () => {
      alive.current = false
      off?.()
    }
  }, [api, load])

  const running = !!data.envios?.some((e) => e.status === 'em_execucao')
  const refreshMs = options.refreshMs ?? HANDOFF_REFRESH_MS
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void load(), refreshMs)
    return () => clearInterval(timer)
  }, [running, refreshMs, load])

  const refresh = useCallback((): void => void load(), [load])

  const correct = useCallback(
    async (entregaId: string, acao: 'concluir' | 'reabrir'): Promise<CorrectionResult> => {
      const a = api()
      if (!a || typeof a.handoffCorrectEntrega !== 'function') {
        return { ok: false, message: 'o app não expõe a correção das entregas (handoff:correctEntrega)' }
      }
      try {
        const res = await a.handoffCorrectEntrega({ entregaId, acao })
        if (!res || res.ok !== true) return { ok: false, message: res && 'message' in res ? res.message : 'resposta inválida do processo principal' }
        // O envio já reavaliado entra na lista na hora; o handoff:changed relê depois.
        if (alive.current) {
          setData((prev) =>
            prev.envios ? { ...prev, envios: prev.envios.map((e) => (e.id === res.envio.id ? res.envio : e)) } : prev
          )
        }
        return { ok: true, envio: res.envio }
      } catch (err) {
        return { ok: false, message: ipcErrorMessage(err, 'falha ao corrigir a entrega') }
      }
    },
    [api]
  )

  return { envios: data.envios, error: data.error, refresh, correct }
}
