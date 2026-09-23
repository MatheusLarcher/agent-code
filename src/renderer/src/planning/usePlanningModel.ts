/**
 * O modelo e o esforço do Agent Manager, editados direto no chat da Tela de
 * Planejamento (o seletor do composer) em vez de Configurações.
 *
 * É a mesma config de sempre (`AppConfig.planning`): o main a lê quando a
 * sessão do Manager sobe (`planningStartOptions`), então quem troca aqui ainda
 * precisa reiniciar a sessão para valer — isso fica com o App, que sabe se ela
 * está ocupada.
 */
import { useCallback, useEffect, useState } from 'react'
import { clampEffortToModel, DEFAULT_CONFIG, type EffortLevel, type PlanningConfig } from '@shared/ipc'

export interface PlanningModelControls {
  config: PlanningConfig
  setModel: (model: string) => void
  setEffort: (effort: EffortLevel) => void
}

export function usePlanningModel(): PlanningModelControls {
  const [config, setConfig] = useState<PlanningConfig>(DEFAULT_CONFIG.planning)

  useEffect(() => {
    let alive = true
    void window.api
      .getConfig()
      .then((c) => {
        if (alive && c.planning) setConfig(c.planning)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const save = useCallback((next: PlanningConfig): void => {
    setConfig(next)
    void window.api.setConfig({ planning: next })
  }, [])

  const setModel = useCallback(
    (model: string) => save({ model, effort: clampEffortToModel(model, config.effort) }),
    [save, config.effort]
  )
  const setEffort = useCallback((effort: EffortLevel) => save({ ...config, effort }), [save, config])

  return { config, setModel, setEffort }
}
