import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react'
import type { HandoffEnvio } from '@shared/handoffTracking'
import type { DeliveriesState } from './useDeliveries'
import type { DeliveryCenter } from './useDeliveryCenter'

/**
 * O centro de Entregas do App (useDeliveryCenter) para quem está lá no fundo da
 * árvore — a aba Implantação da TV do escritório —, sem outra leitura do
 * handoff:list e sem passar props pelo Office3DWorkspace. Sem o Provider (os
 * testes do escritório), `useDeliveryCenterContext()` é null e a aba não existe.
 */
export interface DeliveryCenterValue {
  /** `null` = ainda não houve leitura que deu certo. */
  envios: HandoffEnvio[] | null
  /** A última leitura falhou (banco fora do ar). */
  error: string | null
  correct: DeliveriesState['correct']
  /** Abre a conversa de um envio (lendo do banco a que não está na tela). */
  openConversation: (conversationId: string) => void
}

export const DeliveryCenterContext = createContext<DeliveryCenterValue | null>(null)

/** O valor só muda com os envios, o erro ou as ações (o App re-renderiza a cada pedaço do chat). */
export function DeliveryCenterProvider({ center, children }: { center: DeliveryCenter; children: ReactNode }): JSX.Element {
  const { envios, error, correct } = center.state
  const { openConversation } = center
  const value = useMemo(() => ({ envios, error, correct, openConversation }), [envios, error, correct, openConversation])
  return createElement(DeliveryCenterContext.Provider, { value }, children)
}

export function useDeliveryCenterContext(): DeliveryCenterValue | null {
  return useContext(DeliveryCenterContext)
}
