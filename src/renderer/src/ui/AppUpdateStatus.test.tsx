import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { AppUpdateState } from '@shared/ipc'
import { IDLE_UPDATE_STATE } from '../components/useAppUpdate'
import { AppUpdateStatus, describeUpdate, fmtAgo } from './AppUpdateStatus'
import { UiProvider } from './UiProvider'

const st = (patch: Partial<AppUpdateState>): AppUpdateState => ({ ...IDLE_UPDATE_STATE, ...patch })
const NOW = Date.parse('2026-10-24T12:00:00Z')

afterEach(() => {
  cleanup()
  delete (window as unknown as { api?: unknown }).api
})

describe('describeUpdate', () => {
  it('uma linha por fase', () => {
    expect(describeUpdate(IDLE_UPDATE_STATE, NOW)).toBe('Ainda não verificado')
    expect(describeUpdate(st({ checkedAt: '2026-10-24T11:48:00Z' }), NOW)).toBe('Última verificação há 12 min')
    expect(describeUpdate(st({ phase: 'verificando' }), NOW)).toBe('Verificando…')
    expect(describeUpdate(st({ phase: 'baixando', version: '0.1.150', percent: 43 }), NOW)).toBe('Baixando 0.1.150… 43%')
    expect(describeUpdate(st({ phase: 'pronta', version: '0.1.150' }), NOW)).toBe('0.1.150 pronta para instalar')
    expect(describeUpdate(st({ phase: 'agendada', version: '0.1.150' }), NOW)).toBe('Agendada: instala quando os agentes terminarem')
    expect(describeUpdate(st({ phase: 'erro', error: 'sem rede' }), NOW)).toBe('Não foi possível verificar: sem rede')
  })

  it('fmtAgo: minutos, horas, dias', () => {
    expect(fmtAgo('2026-10-24T11:59:30Z', NOW)).toBe('agora há pouco')
    expect(fmtAgo('2026-10-24T09:00:00Z', NOW)).toBe('há 3 h')
    expect(fmtAgo('2026-10-22T12:00:00Z', NOW)).toBe('há 2 dias')
  })
})

describe('AppUpdateStatus', () => {
  it('mostra a versão, o estado e "Verificar agora" chama updateCheckNow', async () => {
    // Fixado antes do render: o `now` do componente é lido ao montar.
    const checkedAt = new Date(Date.now() - 5 * 60_000 - 5_000).toISOString()
    const api = {
      getUpdateState: vi.fn(async () => st({ checkedAt })),
      onUpdateStateChanged: vi.fn(() => () => {}),
      updateCheckNow: vi.fn(async () => st({ phase: 'verificando' }))
    }
    ;(window as unknown as { api: unknown }).api = api
    render(
      <UiProvider>
        <AppUpdateStatus appVersion="0.1.145" />
      </UiProvider>
    )
    expect(screen.getByText('Versão 0.1.145')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Última verificação há 5 min')).toBeTruthy())
    const btn = screen.getByRole('button', { name: 'Verificar agora' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(api.updateCheckNow).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Verificando…')).toBeTruthy()
    expect(btn.disabled).toBe(true)
  })
})
