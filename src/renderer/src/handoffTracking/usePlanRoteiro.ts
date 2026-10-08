import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { PlanRoteiro } from '@shared/stepProgress'
import { appPeekApi, planPeeksFor, roteiroOfPeek, type PeekApi } from '../office3d/tvPlans'

/**
 * O roteiro de UM plano (as etapas com id, na ordem) para numerar "Etapa N de M"
 * pela posição no plano (planProgress): o resumo do planning:peek, no MESMO
 * cache da TV (tvPlans.ts — um pedido por plano, relido quando o plano muda).
 * null enquanto não chega, sem a ponte ou sem plano: quem usa conta pela união
 * das entregas (planProgress sem roteiro).
 */
export function usePlanRoteiro(
  projectCwd: string | null | undefined,
  slug: string | null | undefined,
  /** Injetável nos testes; padrão: window.api. */
  api: PeekApi | null = appPeekApi()
): PlanRoteiro | null {
  const peeks = planPeeksFor(api)
  const subscribe = useCallback(
    (onChange: () => void): (() => void) => {
      if (!peeks || !projectCwd || !slug) return () => {}
      const ref = { cwd: projectCwd, slug }
      peeks.get(ref)
      // Resumo novo ou plano mudado: relê (se ficou velho) e redesenha.
      return peeks.subscribe(() => {
        peeks.get(ref)
        onChange()
      })
    },
    [peeks, projectCwd, slug]
  )
  const peek = useSyncExternalStore(subscribe, () => (peeks && projectCwd && slug ? peeks.cached({ cwd: projectCwd, slug }) : null))
  return useMemo(() => roteiroOfPeek(peek), [peek])
}
