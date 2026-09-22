/**
 * O plano aberto na Tela de Planejamento, para quem é renderizado dentro dela
 * sem receber props dela — as `headerActions`, que o App monta (ex.: o botão
 * de enviar para implementação). null enquanto carrega ou se falhou ao abrir.
 */
import { createContext, useContext } from 'react'
import type { OpenedPlanningDto } from '@shared/ipc'

export const PlanningPlanContext = createContext<OpenedPlanningDto | null>(null)

export function useOpenedPlan(): OpenedPlanningDto | null {
  return useContext(PlanningPlanContext)
}
