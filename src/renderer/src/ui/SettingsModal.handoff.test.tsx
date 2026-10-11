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

const toggle = (title: RegExp): HTMLInputElement => screen.getByText(title).closest('label')!.querySelector('input')!

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Configurações → Geral: interruptores do envio para implementação', () => {
  it('"Ciclo completo" e "Exigir o plano" não aparecem mais', async () => {
    stubApi({ ...DEFAULT_CONFIG })
    await view()
    await waitFor(() => expect(toggle(/Leitura guiada/).matches(':disabled')).toBe(false))
    expect(screen.queryByText(/Ciclo completo nos handoffs/)).toBeNull()
    expect(screen.queryByText(/Exigir o plano antes de escrever/)).toBeNull()
  })

  it('"Leitura guiada": desligada por padrão, explica o que faz e grava só o campo', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    await view()
    await waitFor(() => expect(toggle(/Leitura guiada/).matches(':disabled')).toBe(false))
    expect(toggle(/Leitura guiada/).checked).toBe(false)
    expect(screen.getByText(/seção "Arquivos" no topo/)).toBeTruthy()
    expect(screen.getByText(/Fast mode/)).toBeTruthy()

    fireEvent.click(toggle(/Leitura guiada/))
    expect(api.setConfig).toHaveBeenLastCalledWith({ handoff: { leituraGuiada: true } })
    expect(toggle(/Leitura guiada/).checked).toBe(true)
  })
})
