import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { DEFAULT_CONFIG, type AppConfig, type SkillTierRow } from '@shared/ipc'
import { SettingsModal } from './SettingsModal'
import { UiProvider } from './UiProvider'

const ROWS: SkillTierRow[] = [
  { name: 'brag', description: 'vídeo de lançamento', tier: 'medium', category: 'Vídeo e mídia', defaultTier: 'medium', defaultCategory: 'Vídeo e mídia', fromEcc: false },
  { name: 'click-path-audit', description: 'botões', tier: 'low', category: 'Depuração', defaultTier: 'low', defaultCategory: 'Depuração', fromEcc: true }
]

function stubApi(config: AppConfig): { setConfig: ReturnType<typeof vi.fn>; skillTierList: ReturnType<typeof vi.fn> } {
  const api = {
    getConfig: vi.fn(async (): Promise<AppConfig> => config),
    setConfig: vi.fn(async () => {}),
    skillTierList: vi.fn(async () => ROWS),
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

async function openSkillsTab(): Promise<void> {
  await act(async () => {
    render(
      <UiProvider>
        <SettingsModal onClose={() => undefined} skipPerms={false} onToggleSkipPerms={() => undefined} windowsControlEnabled={false} onToggleWindowsControl={() => undefined} />
      </UiProvider>
    )
  })
  fireEvent.click(screen.getByRole('tab', { name: /Skills/ }))
}

const tieredToggle = (): HTMLInputElement => screen.getByText(/Catálogo de skills em níveis/).closest('label')!.querySelector('input')!

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Configurações → Skills', () => {
  it('interruptor desligado por padrão, explica o que faz e grava só o campo', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    await openSkillsTab()
    await waitFor(() => expect(tieredToggle().matches(':disabled')).toBe(false))
    expect(tieredToggle().checked).toBe(false)
    expect(screen.getByText(/só o nome, por categoria/)).toBeTruthy()
    fireEvent.click(tieredToggle())
    expect(api.setConfig).toHaveBeenLastCalledWith({ skillCatalog: { tiered: true } })
  })

  it('editor: troca nível e categoria e grava o mapa de ajustes; voltar ao padrão tira o ajuste', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    await openSkillsTab()
    const row = await screen.findByRole('row', { name: /brag/ })
    fireEvent.change(within(row).getByLabelText('Nível de brag'), { target: { value: 'low' } })
    expect(api.setConfig).toHaveBeenLastCalledWith({ skillCatalog: { overrides: { brag: { tier: 'low', category: 'Vídeo e mídia' } } } })
    expect(within(row).getByText('ajustada')).toBeTruthy()
    fireEvent.change(within(row).getByLabelText('Nível de brag'), { target: { value: 'medium' } })
    expect(api.setConfig).toHaveBeenLastCalledWith({ skillCatalog: { overrides: {} } })
  })

  it('filtro por nome e a marca das skills do ECC', async () => {
    stubApi({ ...DEFAULT_CONFIG })
    await openSkillsTab()
    await screen.findByRole('row', { name: /brag/ })
    expect(within(screen.getByRole('row', { name: /click-path-audit/ })).getByText('ECC')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Filtrar skills'), { target: { value: 'click' } })
    expect(screen.queryByRole('row', { name: /brag/ })).toBeNull()
  })

  it('lista que falha: avisa, sem quebrar a aba', async () => {
    const api = stubApi({ ...DEFAULT_CONFIG })
    api.skillTierList.mockRejectedValue(new Error('disco fora'))
    await openSkillsTab()
    expect(await screen.findByText(/Não foi possível listar as skills: disco fora/)).toBeTruthy()
  })
})
