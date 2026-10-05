import { useEffect, useRef } from 'react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import type { NotifyOptions, ToastType } from '../ui/UiProvider'
import { deliveryNotices } from './deliveryChanges'

export interface DeliveryToastDeps {
  notify: (tipo: ToastType, msg: string, opts?: NotifyOptions) => void
  /** Clique no toast: abre a conversa do envio. */
  openConversation: (conversationId: string) => void
}

/**
 * Toast quando um envio ou entrega de QUALQUER projeto fica concluído,
 * incompleto, parado ou atrasado: compara cada leitura com a anterior. A
 * primeira leitura é só a base — abrir o app não repete o que já tinha acontecido.
 */
export function useDeliveryToasts(envios: readonly HandoffEnvio[] | null, deps: DeliveryToastDeps): void {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const prev = useRef<readonly HandoffEnvio[] | null>(null)

  useEffect(() => {
    if (!envios) return
    const before = prev.current
    prev.current = envios
    if (!before || before === envios) return
    for (const n of deliveryNotices(before, envios)) {
      depsRef.current.notify(n.tipo, n.msg, { onClick: () => depsRef.current.openConversation(n.conversationId) })
    }
  }, [envios])
}
