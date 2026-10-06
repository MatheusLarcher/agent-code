import { useEffect, useRef, useState } from 'react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { HANDOFF_REFRESH_MS, type HandoffEnviosApi, type HandoffEnviosState } from '../handoffTracking/useHandoffEnvios'
import { planEnviosOf } from './planObra'

/**
 * Os envios de UM plano (a obra dele: planObra.ts), lidos do banco (handoff:list
 * do projeto, filtrado pelo slug) e relidos a cada aviso handoff:changed — de
 * qualquer conversa: um envio novo nasce numa conversa que esta tela ainda não
 * conhece — e, enquanto algum está em execução, a cada minuto (o tempo ativo).
 * Nada aqui vem do texto do modelo: é o que o app mediu e gravou.
 */

/** O teto do handoff:list: um projeto com muitos planos não pode esconder os envios deste. */
const LIST_LIMIT = 1000

function windowApi(): HandoffEnviosApi | null {
  const api = (window as unknown as { api?: Partial<HandoffEnviosApi> }).api
  return api && typeof api.handoffList === 'function' && typeof api.onHandoffChanged === 'function' ? (api as HandoffEnviosApi) : null
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function usePlanObra(
  projectCwd: string,
  slug: string,
  options: { api?: HandoffEnviosApi; refreshMs?: number } = {}
): HandoffEnviosState {
  const apiRef = useRef(options.api)
  apiRef.current = options.api
  const loadRef = useRef<(() => Promise<void>) | null>(null)
  const key = `${projectCwd}\u0000${slug}`
  const [state, setState] = useState<HandoffEnviosState & { key: string }>({ key: '', envios: null, error: null })

  useEffect(() => {
    loadRef.current = null
    const api = apiRef.current ?? windowApi()
    // Sem o canal (testes antigos, versões sem o acompanhamento): não há obra a mostrar.
    if (!api || !projectCwd || !slug) return
    let alive = true
    let seq = 0
    const load = async (): Promise<void> => {
      const mine = ++seq
      try {
        const res = await api.handoffList({ projectCwd, limit: LIST_LIMIT })
        if (!alive || mine !== seq) return
        if (res && res.ok === true) setState({ key, envios: planEnviosOf(res.envios, projectCwd, slug), error: null })
        else setState((prev) => ({ key, envios: prev.key === key ? prev.envios : null, error: res && 'message' in res ? res.message : 'resposta inválida' }))
      } catch (err) {
        if (alive && mine === seq) setState((prev) => ({ key, envios: prev.key === key ? prev.envios : null, error: errText(err) }))
      }
    }
    loadRef.current = load
    void load()
    let off: (() => void) | undefined
    try {
      off = api.onHandoffChanged(() => void load())
    } catch {
      // Sem o aviso: fica a leitura de agora (e a periódica, se houver obra em execução).
    }
    return () => {
      alive = false
      loadRef.current = null
      off?.()
    }
  }, [projectCwd, slug, key])

  const mine = state.key === key
  const running = mine && (state.envios ?? []).some((e: HandoffEnvio) => e.status === 'em_execucao')
  const refreshMs = options.refreshMs ?? HANDOFF_REFRESH_MS
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => void loadRef.current?.(), refreshMs)
    return () => clearInterval(timer)
  }, [running, refreshMs, key])

  return mine ? { envios: state.envios, error: state.error } : { envios: null, error: null }
}
