import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CLAUDE_MODELS, DEFAULT_CONFIG, type AppConfig } from '@shared/ipc'
import { SettingsModal } from './SettingsModal'
import { UiProvider } from './UiProvider'

const AUTO_WARNING = 'Sem o TypeSafe ligado, o Automático usa Sonnet 5 (esforço médio).'

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

const modelSelect = (): HTMLSelectElement => screen.getByLabelText('Modelo do Agent Manager') as HTMLSelectElement

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Configurações → Geral: Planejamento', () => {
  it('oferece Automático + os modelos da conversa, e avisa o recuo quando o TypeSafe está desligado', async () => {
    stubApi({ ...DEFAULT_CONFIG })
    await view()

    await waitFor(() => expect(modelSelect().value).toBe('auto'))
    const options = [...modelSelect().options].map((o) => o.value)
    expect(options).toEqual(['auto', ...CLAUDE_MODELS.map((m) => m.id)])
    // No Automático o esforço é decidido pelo TypeSafe (ou pelo recuo): sem seletor.
    expect(screen.queryByLabelText('Esforço do Agent Manager')).toBeNull()
    expect(screen.getByText(AUTO_WARNING)).toBeTruthy()
  })

  it('com TypeSafe ligado, o Automático não mostra o aviso de recuo', async () => {
    stubApi({ ...DEFAULT_CONFIG, typesafe: { ...DEFAULT_CONFIG.typesafe, enabled: true } })
    await view()

    await waitFor(() => expect(modelSelect().value).toBe('auto'))
    expect(screen.queryByText(AUTO_WARNING)).toBeNull()
  })

  it('fixar um modelo salva pelo setConfig e revela o esforço com os níveis dele', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    await view()
    await waitFor(() => expect(modelSelect().value).toBe('auto'))

    await act(async () => {
      fireEvent.change(modelSelect(), { target: { value: 'claude-sonnet-5' } })
    })
    expect(api.setConfig).toHaveBeenCalledWith({ planning: { model: 'claude-sonnet-5', effort: 'medium' } })
    expect(screen.queryByText(AUTO_WARNING)).toBeNull()

    const effort = screen.getByLabelText('Esforço do Agent Manager') as HTMLSelectElement
    expect(effort.value).toBe('medium')
    expect([...effort.options].map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])

    await act(async () => {
      fireEvent.change(effort, { target: { value: 'xhigh' } })
    })
    expect(api.setConfig).toHaveBeenLastCalledWith({ planning: { model: 'claude-sonnet-5', effort: 'xhigh' } })
  })
})
