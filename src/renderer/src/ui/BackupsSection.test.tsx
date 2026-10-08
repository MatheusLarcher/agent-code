import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { StorageStatusDto } from '@shared/ipc'
import type { DatabaseBackupListDto } from '@shared/databaseBackup'
import { UiProvider } from './UiProvider'
import { BackupsSection, formatBytes } from './BackupsSection'

afterEach(cleanup)

const ready: StorageStatusDto = { backend: 'postgres', state: 'postgres-ready', writable: true, installationId: 'i', targetDatabase: 'agent-code', hasPassword: true }

function setup(list: Partial<DatabaseBackupListDto> = {}) {
  const data: DatabaseBackupListDto = {
    dir: 'D:\\OneDrive\\agent-code\\backups',
    totalBytes: 3 * 1024 * 1024,
    running: null,
    activeSide: 'nuvem',
    cloudEnabled: true,
    items: [
      { file: '2026-10-08_0010_nuvem_diario.dump', createdAt: '2026-10-08T03:10:00.000Z', side: 'nuvem', reason: 'diario', appVersion: '0.1.93', conversations: 120, lastUpdate: null, sizeBytes: 2 * 1024 * 1024 },
      { file: '2026-10-07_2300_local_antes-da-troca.dump', createdAt: '2026-10-08T02:00:00.000Z', side: 'local', reason: 'antes-da-troca', appVersion: '0.1.93', conversations: 80, lastUpdate: null, sizeBytes: 1024 * 1024 }
    ],
    ...list
  }
  const api = {
    listDatabaseBackups: vi.fn(async () => data),
    deleteDatabaseBackup: vi.fn(async () => undefined),
    restoreDatabaseBackup: vi.fn(async () => ({ relaunch: false, message: 'Backup restaurado no banco local.' })),
    onDatabaseBackupsChanged: vi.fn(() => () => undefined),
    getStorageStatus: vi.fn(async () => ready),
    onStorageStatusChanged: vi.fn(() => () => undefined)
  }
  ;(window as unknown as { api: unknown }).api = api
  render(
    <UiProvider>
      <BackupsSection />
    </UiProvider>
  )
  return api
}

describe('BackupsSection', () => {
  it('lista data, lado, motivo, conversas e tamanho, e o peso da pasta', async () => {
    setup()
    expect(await screen.findByText(/nuvem · diário/)).toBeTruthy()
    expect(screen.getByText(/local · antes da troca/)).toBeTruthy()
    expect(screen.getByText('120 conversa(s) · 2.0 MB')).toBeTruthy()
    expect(screen.getByText(/2 backup\(s\), 3\.0 MB na pasta/)).toBeTruthy()
    expect(formatBytes(512)).toBe('1 KB')
  })

  it('restaurar: escolhe o destino (local ou nuvem, com a nuvem ligada) e confirma', async () => {
    const api = setup()
    const row = (await screen.findByText(/local · antes da troca/)).closest('.settings-list-row') as HTMLElement
    fireEvent.click(row.querySelector('button') as HTMLButtonElement)
    // Abre com o destino em uso (a nuvem) marcado; o usuário troca para o local.
    const local = screen.getByRole('radio', { name: /No banco local/ }) as HTMLInputElement
    expect((screen.getByRole('radio', { name: /Na nuvem/ }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(local)
    expect(screen.queryByText(/O app reinicia ao terminar/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar' }))
    await waitFor(() =>
      expect(api.restoreDatabaseBackup).toHaveBeenCalledWith({ file: '2026-10-07_2300_local_antes-da-troca.dump', target: 'local' })
    )
  })

  it('sem nuvem ligada, o destino é só o banco local (sem escolha)', async () => {
    setup({ activeSide: 'local', cloudEnabled: false })
    const row = (await screen.findByText(/nuvem · diário/)).closest('.settings-list-row') as HTMLElement
    fireEvent.click(row.querySelector('button') as HTMLButtonElement)
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByText(/O app reinicia ao terminar/)).toBeTruthy()
  })
})
