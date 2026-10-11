import { useEffect, useRef } from 'react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { handoffNoticeText, isHandoffNotice, type HandoffNotice } from '@shared/handoffNotice'
import type { NotifyOptions, ToastType } from '../ui/UiProvider'
import { deliveryNotices } from './deliveryChanges'

export interface DeliveryToastDeps {
  notify: (tipo: ToastType, msg: string, opts?: NotifyOptions) => void
  /** Clique no toast: abre a conversa do envio. */
  openConversation: (conversationId: string) => void
  /** Os avisos de handoff ao vivo (handoff:notice); ausente em versões/testes sem o canal. */
  subscribeNotices?: (cb: (notice: HandoffNotice) => void) => () => void
}

/**
 * Toast quando um envio ou entrega de QUALQUER projeto fica concluído,
 * incompleto, parado ou atrasado: compara cada leitura com a anterior. A
 * primeira leitura é só a base — abrir o app não repete o que já tinha acontecido.
 *
 * Mais os avisos ao vivo da conversa de handoff (decisão sozinha, ATENÇÃO,
 * DESVIO DO PLANO). Os da fila (`fila`) o app já tira da mudança de status;
 * o main os manda só para o celular não ficar sem eles.
 */
export function useDeliveryToasts(envios: readonly HandoffEnvio[] | null, deps: DeliveryToastDeps): void {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const prev = useRef<readonly HandoffEnvio[] | null>(null)
  const enviosRef = useRef(envios)
  enviosRef.current = envios

  useEffect(() => {
    if (!envios) return
    const before = prev.current
    prev.current = envios
    if (!before || before === envios) return
    for (const n of deliveryNotices(before, envios)) {
      depsRef.current.notify(n.tipo, n.msg, { onClick: () => depsRef.current.openConversation(n.conversationId) })
    }
  }, [envios])

  const subscribe = deps.subscribeNotices
  useEffect(() => {
    if (!subscribe) return
    return subscribe((notice) => {
      if (!isHandoffNotice(notice) || notice.tipo === 'fila') return
      const title = enviosRef.current?.find((e) => e.conversationId === notice.convId)?.conversationTitle
      depsRef.current.notify('aviso', handoffNoticeText(notice, title), { onClick: () => depsRef.current.openConversation(notice.convId) })
    })
  }, [subscribe])
}
