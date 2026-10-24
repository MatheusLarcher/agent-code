import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/ipc'
import { SettingsModal } from './SettingsModal'
import { UiProvider } from './UiProvider'

function stubApi(config: AppConfig): { setConfig: ReturnType<typeof vi.fn> } {
  const api = {
    getConfig: vi.fn(async (): Promise<AppConfig> => config),
    setConfig: vi.fn(async () => {}),
    getCacheInfo: vi.fn(async () => ({ dir: 'C:/dados', dbPath: 'C:/dados/app.db' })),
    getAppVersion: vi.fn(async () => '0.0.0'),
    getUpdateState: vi.fn(async () => ({ phase: 'ocioso', version: null, percent: null, checkedAt: null, error: null, canInstallNow: false, blockedBy: null })),
    onUpdateStateChanged: vi.fn(() => () => {}),
    updateCheckNow: vi.fn(async () => ({ phase: 'verificando', version: null, percent: null, checkedAt: null, error: null, canInstallNow: false, blockedBy: null })),
    updateInstallNow: vi.fn(async () => ({ ok: true })),
    updateScheduleWhenIdle: vi.fn(async () => ({ phase: 'agendada', version: null, percent: null, checkedAt: null, error: null, canInstallNow: false, blockedBy: null })),
    updateCancelSchedule: vi.fn(async () => ({ phase: 'pronta', version: null, percent: null, checkedAt: null, error: null, canInstallNow: true, blockedBy: null })),
    getChromeBridgeStatus: vi.fn(async () => ({ listening: false, port: null, connected: false, extensionVersion: null, userAgent: null })),
    onChromeControlChanged: vi.fn(() => () => {}),
    onChromeBridgeStatusChanged: vi.fn(() => () => {}),
    codexStatus: vi.fn(async () => ({ connected: false }))
  }
  ;(window as unknown as { api: unknown }).api = api
  return api
}

async function view(): Promise<void> {
  await act(async () => {
    render(
      <UiProvider>
        <SettingsModal
          onClose={() => undefined}
          skipPerms={false}
          onToggleSkipPerms={() => undefined}
          windowsControlEnabled={false}
          onToggleWindowsControl={() => undefined}
        />
      </UiProvider>
    )
  })
}

const radio = (name: 'Haiku' | 'TypeSafe'): HTMLInputElement =>
  screen.getByRole('radiogroup', { name: 'Seleção de memórias' }).querySelector<HTMLInputElement>(
    `input[value="${name.toLowerCase()}"]`
  )!

const WARN = /O TypeSafe não está configurado — o Haiku segue escolhendo até você ativá-lo\./

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Configurações → Geral: seleção de memórias', () => {
  it('Haiku marcado por padrão (config sem o campo) e cada opção explica o que faz', async () => {
    const semCampo: Partial<AppConfig> = { ...DEFAULT_CONFIG }
    delete semCampo.memorySelector
    stubApi(semCampo as AppConfig)
    await view()
    await waitFor(() => expect(radio('Haiku').matches(':disabled')).toBe(false))
    expect(radio('Haiku').checked).toBe(true)
    expect(radio('TypeSafe').checked).toBe(false)
    expect(screen.getByText(/escolhe até 15 para o agente e os subagentes/)).toBeTruthy()
    expect(screen.getByText(/escolhe até 3 memórias só pela mensagem/)).toBeTruthy()
    expect(screen.queryByText(WARN)).toBeNull()
  })

  it('trocar para TypeSafe grava só o campo e, sem TypeSafe configurado, avisa sem bloquear', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, enabled: false, apiKey: '' } })
    await view()
    await waitFor(() => expect(radio('TypeSafe').matches(':disabled')).toBe(false))

    fireEvent.click(radio('TypeSafe'))
    expect(api.setConfig).toHaveBeenLastCalledWith({ memorySelector: 'typesafe' })
    expect(radio('TypeSafe').checked).toBe(true)
    expect(screen.getByText(WARN)).toBeTruthy()

    fireEvent.click(radio('Haiku'))
    expect(api.setConfig).toHaveBeenLastCalledWith({ memorySelector: 'haiku' })
    expect(screen.queryByText(WARN)).toBeNull()
  })

  it('TypeSafe já gravado e configurado: vem marcado e sem aviso', async () => {
    stubApi({
      ...DEFAULT_CONFIG,
      memorySelector: 'typesafe',
      typesafe: { ...DEFAULT_CONFIG.typesafe, enabled: true, apiKey: 'ts-key' }
    } as AppConfig)
    await view()
    await waitFor(() => expect(radio('TypeSafe').checked).toBe(true))
    expect(screen.queryByText(WARN)).toBeNull()
  })
})
