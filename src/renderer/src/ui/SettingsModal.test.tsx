import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, type AppConfig } from '@shared/ipc'
import { usePlanningModel } from '../planning/usePlanningModel'
import { SettingsModal } from './SettingsModal'
import { UiProvider } from './UiProvider'

function stubApi(config: AppConfig): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    getConfig: vi.fn(async (): Promise<AppConfig> => config),
    setConfig: vi.fn(async () => {}),
    getCacheInfo: vi.fn(async () => ({ dir: 'C:/dados', dbPath: 'C:/dados/app.db' })),
    getAppVersion: vi.fn(async () => '0.0.0'),
    codexStatus: vi.fn(async () => ({ connected: false }))
  }
  ;(window as unknown as { api: unknown }).api = api
  return api as unknown as Record<string, ReturnType<typeof vi.fn>>
}

const view = async (): Promise<void> => {
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Configurações → Geral: Planejamento', () => {
  it('o modelo do Agent Manager saiu daqui — é trocado no próprio chat de planejamento', async () => {
    stubApi({ ...DEFAULT_CONFIG })
    await view()
    await waitFor(() => expect(screen.getAllByRole('button').length).toBeGreaterThan(0))
    expect(screen.queryByLabelText('Modelo do Agent Manager')).toBeNull()
    expect(screen.queryByLabelText('Esforço do Agent Manager')).toBeNull()
  })
})

describe('usePlanningModel — o seletor do chat de planejamento', () => {
  function Probe(): JSX.Element {
    const { config, setModel, setEffort } = usePlanningModel()
    return (
      <div>
        <span data-testid="cfg">{`${config.model}|${config.effort}`}</span>
        <button type="button" onClick={() => setModel('claude-sonnet-5')}>sonnet</button>
        <button type="button" onClick={() => setEffort('xhigh')}>xhigh</button>
      </div>
    )
  }

  it('lê a config salva e grava modelo e esforço pelo setConfig', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG, planning: { model: 'auto', effort: 'medium' } })
    render(<Probe />)
    await waitFor(() => expect(api.getConfig).toHaveBeenCalled())
    expect(screen.getByTestId('cfg').textContent).toBe('auto|medium')

    fireEvent.click(screen.getByText('sonnet'))
    expect(api.setConfig).toHaveBeenLastCalledWith({ planning: { model: 'claude-sonnet-5', effort: 'medium' } })
    fireEvent.click(screen.getByText('xhigh'))
    expect(api.setConfig).toHaveBeenLastCalledWith({ planning: { model: 'claude-sonnet-5', effort: 'xhigh' } })
    expect(screen.getByTestId('cfg').textContent).toBe('claude-sonnet-5|xhigh')
  })
})
