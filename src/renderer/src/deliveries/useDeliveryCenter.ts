import { useCallback, useMemo, useRef } from 'react'
import { needsUserCount } from './deliveryModel'
import { openConversationById, type OpenConversationDeps } from './deliveriesNav'
import { useDeliveries, type DeliveriesApi, type DeliveriesState } from './useDeliveries'
import { useDeliveryToasts } from './useDeliveryToasts'

/**
 * O que o App monta das Entregas, sempre: a leitura de todos os envios, o
 * contador da barra e os toasts de mudança (que abrem a conversa no clique).
 * A tela Entregas usa a mesma leitura.
 */
export interface DeliveryCenter {
  state: DeliveriesState
  /** Envios que precisam de você (o contador da barra). */
  count: number
  /** Abre a conversa de um envio (lendo do banco a que não está na tela). */
  openConversation: (conversationId: string) => void
}

export function useDeliveryCenter(deps: OpenConversationDeps, options: { api?: DeliveriesApi } = {}): DeliveryCenter {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const state = useDeliveries(options)
  const openConversation = useCallback((id: string): void => void openConversationById(id, depsRef.current), [])
  useDeliveryToasts(state.envios, { notify: deps.notify, openConversation })
  const count = useMemo(() => needsUserCount(state.envios), [state.envios])
  return { state, count, openConversation }
}
