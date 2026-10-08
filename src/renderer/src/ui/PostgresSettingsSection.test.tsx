import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PostgresPublicSettings, StorageStatusDto } from '@shared/ipc'
import type { CloudInspectionDto } from '@shared/databaseBackup'
import { UiProvider } from './UiProvider'
import { PostgresSettingsSection } from './PostgresSettingsSection'

afterEach(cleanup)

const ready: StorageStatusDto = { backend: 'postgres', state: 'postgres-ready', writable: true, installationId: 'i', targetDatabase: 'agent-code', hasPassword: false }
const saved: PostgresPublicSettings = { host: 'db.exemplo', port: 6502, user: 'app', maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '', targetDatabase: 'agent-code', hasPassword: false, postgresTarget: 'local' }

function inspection(over: Partial<CloudInspectionDto> = {}): CloudInspectionDto {
  return {
    action: 'ligar',
    local: { side: 'local', reachable: true, exists: true, conversations: 42, lastUpdate: '2026-10-08T09:00:00.000Z', serverVersion: '18.6' },
    cloud: { side: 'nuvem', reachable: true, exists: false, conversations: 0, lastUpdate: null, serverVersion: '18.6' },
    otherInstallations: [],
    suggested: 'local',
    olderCloudServer: false,
    options: [
      { keep: 'local', copies: true, overwrites: 'nuvem', description: 'As conversas deste PC sobem para a nuvem.' },
      { keep: 'nuvem', copies: false, overwrites: null, description: 'O app passa a usar a nuvem como ela está.' }
    ],
    ...over
  }
}

function setup(target: 'local' | 'cloud', found: CloudInspectionDto) {
  const api = {
    getStorageStatus: vi.fn(async () => ready),
    getPostgresSettings: vi.fn(async () => ({ ...saved, postgresTarget: target })),
    onStorageStatusChanged: vi.fn(() => () => undefined),
    onStorageTransitionResult: vi.fn(() => () => undefined),
    testPostgresConnection: vi.fn(async () => undefined),
    inspectCloudDatabase: vi.fn(async () => found),
    switchCloudDatabase: vi.fn(async () => ({ message: 'Nuvem ligada. O app vai reiniciar.' })),
    activatePostgres: vi.fn(),
    retryStorage: vi.fn(),
    clearPostgresPassword: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = api
  render(
    <UiProvider>
      <PostgresSettingsSection />
    </UiProvider>
  )
  return api
}

const toggle = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Usar PostgreSQL na nuvem' }) as HTMLInputElement

describe('PostgresSettingsSection — nuvem opcional', () => {
  it('padrão local: a chave liga, mostra os campos, e "Testar e continuar" abre o diálogo com o lado não vazio marcado', async () => {
    const api = setup('local', inspection())
    await waitFor(() => expect(toggle().disabled).toBe(false))
    expect(toggle().checked).toBe(false)
    expect(screen.queryByText('Host')).toBeNull()
    expect(screen.queryByText(/migrar para SQLite/)).toBeNull()
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole('button', { name: 'Testar e continuar…' }))
    await screen.findByRole('dialog', { name: 'Ligar a nuvem' })
    expect(api.inspectCloudDatabase).toHaveBeenCalledWith('ligar', expect.objectContaining({ host: 'db.exemplo', port: 6502 }))
    expect(screen.getByText(/42 conversa\(s\)/)).toBeTruthy()
    expect(screen.getByText(/Vazio — o banco agent-code ainda não existe/)).toBeTruthy()
    expect((screen.getByRole('radio', { name: /Manter os dados locais/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))
    await waitFor(() =>
      expect(api.switchCloudDatabase).toHaveBeenCalledWith({ action: 'ligar', keep: 'local', draft: expect.objectContaining({ host: 'db.exemplo' }) })
    )
  })

  it('nuvem ligada: desligar abre o diálogo com a conexão salva; sem sugestão, só confirma depois de escolher', async () => {
    const api = setup('cloud', inspection({ action: 'desligar', suggested: null, options: [
      { keep: 'nuvem', copies: true, overwrites: 'local', description: 'O que está na nuvem é copiado para este PC.' },
      { keep: 'local', copies: false, overwrites: null, description: 'O app volta ao banco local como ele está.' }
    ] }))
    await waitFor(() => expect(toggle().checked).toBe(true))
    fireEvent.click(toggle())
    await screen.findByRole('dialog', { name: 'Desligar a nuvem' })
    expect(api.inspectCloudDatabase).toHaveBeenCalledWith('desligar', undefined)
    const confirm = screen.getByRole('button', { name: 'Confirmar' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /Manter os dados da nuvem/ }))
    fireEvent.click(confirm)
    await waitFor(() => expect(api.switchCloudDatabase).toHaveBeenCalledWith({ action: 'desligar', keep: 'nuvem' }))
  })

  it('ligar mantendo os locais avisa quando a nuvem foi usada por outro PC ou é mais antiga', async () => {
    setup('local', inspection({ otherInstallations: [{ appVersion: '0.1.90', lastSeenAt: '2026-10-07T20:00:00.000Z' }], olderCloudServer: true }))
    await waitFor(() => expect(toggle().disabled).toBe(false))
    fireEvent.click(toggle())
    fireEvent.click(screen.getByRole('button', { name: 'Testar e continuar…' }))
    await screen.findByRole('dialog')
    expect(screen.getByText(/Outro PC usou esta nuvem/)).toBeTruthy()
    expect(screen.getByText(/mais antigo que o 18/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /Manter os dados da nuvem/ }))
    expect(screen.queryByText(/Outro PC usou esta nuvem/)).toBeNull()
  })

  it('nuvem fora do ar ao desligar: só dá para manter os dados locais', async () => {
    setup('cloud', inspection({
      action: 'desligar',
      suggested: null,
      cloud: { side: 'nuvem', reachable: false, exists: false, conversations: 0, lastUpdate: null, serverVersion: null, error: 'A conexão PostgreSQL foi recusada.' },
      options: [
        { keep: 'nuvem', copies: true, overwrites: 'local', description: 'copia' },
        { keep: 'local', copies: false, overwrites: null, description: 'volta' }
      ]
    }))
    await waitFor(() => expect(toggle().checked).toBe(true))
    fireEvent.click(toggle())
    await screen.findByRole('dialog')
    expect(screen.getByText(/Sem conexão: A conexão PostgreSQL foi recusada/)).toBeTruthy()
    expect((screen.getByRole('radio', { name: /Manter os dados da nuvem/ }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('radio', { name: /Manter os dados locais/ }) as HTMLInputElement).disabled).toBe(false)
  })
})
