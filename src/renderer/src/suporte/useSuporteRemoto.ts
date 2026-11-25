import { useEffect, useState } from 'react'
import type { SuporteApi } from '@shared/suporteApi'
import type { SuporteAjustes, SuporteStatus } from '@shared/suporteRemoto'

const SEM_SESSAO: SuporteStatus = { estado: 'desligado', convId: null }

/** A `window.api` do suporte, ou null onde ela não existe (o app do celular não tem). */
export function suporteApi(): SuporteApi | null {
  const api = (window as unknown as { api?: Partial<SuporteApi> }).api
  return api && typeof api.getSuporteStatus === 'function' && typeof api.getSuporteAjustes === 'function' ? (api as SuporteApi) : null
}

export interface SuporteRemotoNaTela {
  /** null até a primeira resposta (e para sempre onde o suporte não existe). */
  ajustes: SuporteAjustes | null
  status: SuporteStatus
  /** O estado de quando a tela abriu já chegou: daqui em diante, mudança é novidade. */
  pronto: boolean
}

/** Ajustes e estado da sessão de suporte remoto, sempre em dia com o processo principal. */
export function useSuporteRemoto(): SuporteRemotoNaTela {
  const [ajustes, setAjustes] = useState<SuporteAjustes | null>(null)
  const [estado, setEstado] = useState<{ status: SuporteStatus; pronto: boolean }>({ status: SEM_SESSAO, pronto: false })

  useEffect(() => {
    const api = suporteApi()
    if (!api) return
    let vivo = true
    void api
      .getSuporteAjustes()
      .then((a) => vivo && setAjustes(a))
      .catch(() => undefined)
    void api
      .getSuporteStatus()
      .then((status) => vivo && setEstado({ status, pronto: true }))
      .catch(() => vivo && setEstado((atual) => ({ ...atual, pronto: true })))
    const semAjustes = api.onSuporteAjustesMudou(setAjustes)
    const semStatus = api.onSuporteStatusMudou((status) => setEstado((atual) => ({ ...atual, status })))
    return () => {
      vivo = false
      semAjustes()
      semStatus()
    }
  }, [])

  return { ajustes, status: estado.status, pronto: estado.pronto }
}
