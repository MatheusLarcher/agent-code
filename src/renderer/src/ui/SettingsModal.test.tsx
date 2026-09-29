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
    getChromeBridgeStatus: vi.fn(async () => ({
      listening: false,
      port: null,
      connected: false,
      extensionVersion: null,
      userAgent: null
    })),
    onChromeControlChanged: vi.fn(() => () => {}),
    onChromeBridgeStatusChanged: vi.fn(() => () => {}),
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

// Incidente: com o banco offline a leitura falhava, a tela liberava os padrões
// (keys vazias) e cada interruptor mandava o grupo inteiro — apagando a key real.
describe('Configurações: leitura que falha e gravação só do campo alterado', () => {
  const typeSafeToggle = (): HTMLInputElement =>
    screen.getByText(/TypeSafe — decisões rápidas/).closest('label')!.querySelector('input')!

  it('getConfig rejeita: aviso + Tentar de novo, controles travados, nada é gravado; retry habilita', async () => {
    const config = { ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, apiKey: 'ts-real' } }
    const api = stubApi(config)
    // Toda leitura falha (a seção do Chrome também lê a config) até o banco voltar.
    api.getConfig.mockRejectedValue(new Error('Storage autoritativo offline.'))
    await view()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Storage autoritativo offline.')
    expect(typeSafeToggle().matches(':disabled')).toBe(true)
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(typeSafeToggle())
    expect(api.setConfig).not.toHaveBeenCalled()

    api.getConfig.mockResolvedValue(config)
    await act(async () => {
      fireEvent.click(screen.getByText('Tentar de novo'))
    })
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(typeSafeToggle().matches(':disabled')).toBe(false)
    expect((screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('o interruptor do TypeSafe grava só {typesafe:{enabled}}, sem a apiKey', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, apiKey: 'ts-real' } })
    await view()
    await waitFor(() => expect(typeSafeToggle().matches(':disabled')).toBe(false))

    fireEvent.click(typeSafeToggle())
    expect(api.setConfig).toHaveBeenLastCalledWith({ typesafe: { enabled: true } })
  })

  it('a key do TypeSafe grava só {typesafe:{apiKey}} ao sair do campo', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, enabled: true } })
    await view()
    const input = await screen.findByPlaceholderText('Cole a key de typesafe.ai')
    await waitFor(() => expect(input.matches(':disabled')).toBe(false))

    fireEvent.change(input, { target: { value: ' ts-nova ' } })
    fireEvent.blur(input)
    expect(api.setConfig).toHaveBeenLastCalledWith({ typesafe: { apiKey: 'ts-nova' } })
  })
})

describe('usePlanningModel — o seletor do chat de planejamento', () => {
  function Probe(): JSX.Element {
    const { config, setModel, setEffort } = usePlanningModel()
    return (
      <div>
        <span data-testid="cfg">{`${config.model}|${config.effort}`}</span>
        <button type="button" onClick={() => setModel('claude-sonnet-5-5')}>sonnet</button>
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
    expect(api.setConfig).toHaveBeenLastCalledWith({ planning: { model: 'claude-sonnet-5-5', effort: 'medium' } })
    fireEvent.click(screen.getByText('xhigh'))
    expect(api.setConfig).toHaveBeenLastCalledWith({ planning: { model: 'claude-sonnet-5-5', effort: 'xhigh' } })
    expect(screen.getByTestId('cfg').textContent).toBe('claude-sonnet-5-5|xhigh')
  })
})
