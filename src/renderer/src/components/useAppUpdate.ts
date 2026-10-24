/**
 * Estado da atualização automática do app, vindo do main (`getUpdateState` +
 * `onUpdateStateChanged`), com as ações do popover e de Configurações.
 *
 * Erros que viram toast (`onError`): `installNow` que o main recusou
 * (`ok: false`) e a volta `instalando → pronta` com `error` (o instalador não
 * subiu). Mocks antigos de `window.api` sem os métodos: fica em `ocioso`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppUpdateState } from '@shared/ipc'
import { ipcErrorMessage } from '../ipcError'

export const IDLE_UPDATE_STATE: AppUpdateState = {
  phase: 'ocioso',
  version: null,
  percent: null,
  checkedAt: null,
  error: null,
  canInstallNow: false,
  blockedBy: null
}

const INSTALL_FAILED = 'Não foi possível iniciar a atualização.'

export interface AppUpdateControls {
  state: AppUpdateState
  /** Relê o estado (ex.: ao abrir o popover — o `blockedBy` muda a cada segundo). */
  refresh: () => Promise<void>
  installNow: () => Promise<void>
  scheduleWhenIdle: () => Promise<void>
  cancelSchedule: () => Promise<void>
  checkNow: () => Promise<void>
}

type UpdateApi = Pick<
  typeof window.api,
  'getUpdateState' | 'onUpdateStateChanged' | 'updateCheckNow' | 'updateInstallNow' | 'updateScheduleWhenIdle' | 'updateCancelSchedule'
>

/** A API de atualização, ou null quando o preload (ou um mock) não a expõe. */
function updateApi(): UpdateApi | null {
  const api = (window as { api?: Partial<UpdateApi> }).api
  if (!api || typeof api.getUpdateState !== 'function') return null
  return api as UpdateApi
}

export function useAppUpdate(opts: { onError?: (message: string) => void } = {}): AppUpdateControls {
  const [state, setState] = useState<AppUpdateState>(IDLE_UPDATE_STATE)
  const onErrorRef = useRef(opts.onError)
  onErrorRef.current = opts.onError
  const phaseRef = useRef(IDLE_UPDATE_STATE.phase)

  const apply = useCallback((next: AppUpdateState): void => {
    if (phaseRef.current === 'instalando' && next.phase === 'pronta' && next.error) onErrorRef.current?.(next.error)
    phaseRef.current = next.phase
    setState(next)
  }, [])

  useEffect(() => {
    const api = updateApi()
    if (!api) return
    let alive = true
    const safe = (s: AppUpdateState): void => {
      if (alive) apply(s)
    }
    void api.getUpdateState().then(safe).catch(() => undefined)
    const off = typeof api.onUpdateStateChanged === 'function' ? api.onUpdateStateChanged(safe) : () => undefined
    return () => {
      alive = false
      off()
    }
  }, [apply])

  /** Roda uma ação que devolve o estado novo; falha de IPC vira toast. */
  const run = useCallback(
    async (call: (api: UpdateApi) => Promise<AppUpdateState>): Promise<void> => {
      const api = updateApi()
      if (!api) return
      try {
        apply(await call(api))
      } catch (error) {
        onErrorRef.current?.(ipcErrorMessage(error, INSTALL_FAILED))
      }
    },
    [apply]
  )

  const refresh = useCallback(() => run((api) => api.getUpdateState()), [run])
  const checkNow = useCallback(() => run((api) => api.updateCheckNow()), [run])
  const scheduleWhenIdle = useCallback(() => run((api) => api.updateScheduleWhenIdle()), [run])
  const cancelSchedule = useCallback(() => run((api) => api.updateCancelSchedule()), [run])

  const installNow = useCallback(async (): Promise<void> => {
    const api = updateApi()
    if (!api) return
    try {
      const r = await api.updateInstallNow()
      if (!r.ok) onErrorRef.current?.(r.message || INSTALL_FAILED)
    } catch (error) {
      onErrorRef.current?.(ipcErrorMessage(error, INSTALL_FAILED))
    }
  }, [])

  return { state, refresh, installNow, scheduleWhenIdle, cancelSchedule, checkNow }
}
