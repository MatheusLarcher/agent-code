import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { AppUpdateState } from '@shared/ipc'
import { IDLE_UPDATE_STATE, useAppUpdate } from './useAppUpdate'

const st = (patch: Partial<AppUpdateState>): AppUpdateState => ({ ...IDLE_UPDATE_STATE, ...patch })

function stubApi(initial: AppUpdateState, install: { ok: boolean; message?: string } = { ok: true }) {
  let push: ((s: AppUpdateState) => void) | null = null
  const api = {
    getUpdateState: vi.fn(async () => initial),
    onUpdateStateChanged: vi.fn((cb: (s: AppUpdateState) => void) => {
      push = cb
      return () => {
        push = null
      }
    }),
    updateCheckNow: vi.fn(async () => st({ phase: 'verificando' })),
    updateInstallNow: vi.fn(async () => install),
    updateScheduleWhenIdle: vi.fn(async () => st({ ...initial, phase: 'agendada' })),
    updateCancelSchedule: vi.fn(async () => st({ ...initial, phase: 'pronta' }))
  }
  ;(window as unknown as { api: unknown }).api = api
  return { api, push: (s: AppUpdateState) => push?.(s) }
}

afterEach(() => {
  delete (window as unknown as { api?: unknown }).api
})

describe('useAppUpdate', () => {
  it('lê o estado ao montar e segue as mudanças do main', async () => {
    const ready = st({ phase: 'pronta', version: '0.1.150', canInstallNow: true })
    const { push } = stubApi(ready)
    const { result } = renderHook(() => useAppUpdate())
    expect(result.current.state).toEqual(IDLE_UPDATE_STATE)
    await waitFor(() => expect(result.current.state).toEqual(ready))
    act(() => push(st({ phase: 'agendada', version: '0.1.150' })))
    expect(result.current.state.phase).toBe('agendada')
  })

  it('installNow recusado (ok: false) vira onError com a mensagem', async () => {
    stubApi(st({ phase: 'pronta', version: '0.1.150' }), { ok: false, message: 'Um agente começou a trabalhar.' })
    const onError = vi.fn()
    const { result } = renderHook(() => useAppUpdate({ onError }))
    await act(() => result.current.installNow())
    expect(onError).toHaveBeenCalledWith('Um agente começou a trabalhar.')
  })

  it('pronta com error logo após instalando vira onError; sem instalando antes, não', async () => {
    const { push } = stubApi(st({ phase: 'pronta', version: '0.1.150', canInstallNow: true }))
    const onError = vi.fn()
    const { result } = renderHook(() => useAppUpdate({ onError }))
    await waitFor(() => expect(result.current.state.phase).toBe('pronta'))
    // Erro antigo que chega sem a fase instalando antes: não é falha do instalador.
    act(() => push(st({ phase: 'pronta', version: '0.1.150', error: 'antigo' })))
    expect(onError).not.toHaveBeenCalled()
    act(() => push(st({ phase: 'instalando', version: '0.1.150' })))
    act(() => push(st({ phase: 'pronta', version: '0.1.150', error: 'O instalador não abriu.' })))
    expect(onError).toHaveBeenCalledWith('O instalador não abriu.')
    expect(result.current.state.phase).toBe('pronta')
  })

  it('ações devolvem o estado novo; checkNow passa a verificando', async () => {
    const { api } = stubApi(st({ phase: 'pronta', version: '0.1.150' }))
    const { result } = renderHook(() => useAppUpdate())
    await act(() => result.current.scheduleWhenIdle())
    expect(result.current.state.phase).toBe('agendada')
    await act(() => result.current.cancelSchedule())
    expect(result.current.state.phase).toBe('pronta')
    await act(() => result.current.checkNow())
    expect(api.updateCheckNow).toHaveBeenCalledTimes(1)
    expect(result.current.state.phase).toBe('verificando')
  })

  it('sem a API no preload (mock antigo): fica em ocioso e nada quebra', async () => {
    ;(window as unknown as { api: unknown }).api = { getAppVersion: vi.fn(async () => 'x') }
    const { result } = renderHook(() => useAppUpdate())
    await act(() => result.current.installNow())
    await act(() => result.current.refresh())
    expect(result.current.state).toEqual(IDLE_UPDATE_STATE)
  })
})
