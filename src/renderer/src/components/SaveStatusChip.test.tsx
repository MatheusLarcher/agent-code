import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { ConversationSaveStatusDto, StorageStatusDto } from '@shared/ipc'
import type { StorageTransitionResultDto } from '@shared/databaseBackup'
import { SaveStatusChip } from './SaveStatusChip'

afterEach(cleanup)

const ready: StorageStatusDto = { backend: 'postgres', state: 'postgres-ready', writable: true, installationId: 'i', targetDatabase: 'agent-code', hasPassword: true }

function setup() {
  const storage: Array<(status: StorageStatusDto) => void> = []
  const results: Array<(result: StorageTransitionResultDto) => void> = []
  const saves: Array<(status: ConversationSaveStatusDto) => void> = []
  ;(window as unknown as { api: unknown }).api = {
    onConversationSaveStatus: (cb: (status: ConversationSaveStatusDto) => void) => (saves.push(cb), () => undefined),
    getConversationSaveStatus: async () => ({ state: 'saved', pending: 0, oldestMs: 0 }),
    onStorageStatusChanged: (cb: (status: StorageStatusDto) => void) => (storage.push(cb), () => undefined),
    getStorageStatus: async () => ready,
    onStorageTransitionResult: (cb: (result: StorageTransitionResultDto) => void) => (results.push(cb), () => undefined)
  }
  return { storage, results, saves }
}

describe('SaveStatusChip — troca de banco e restauração', () => {
  it('durante a troca mostra o passo, não "sem banco" (as gravações estão retidas, não perdidas)', async () => {
    const { storage } = setup()
    render(<SaveStatusChip storageOffline />)
    await act(async () => {
      for (const cb of storage) cb({ ...ready, state: 'switching-postgres', writable: false, transitionStep: 'Copiando a nuvem para o banco local' })
    })
    const chip = screen.getByRole('status')
    expect(chip.textContent).toContain('trocando de banco…')
    expect(chip.getAttribute('title')).toContain('Copiando a nuvem para o banco local')
    await act(async () => {
      for (const cb of storage) cb({ ...ready, state: 'restoring-postgres', writable: false })
    })
    expect(screen.getByRole('status').textContent).toContain('restaurando backup…')
  })

  it('troca da ferramenta do agente que falhou em segundo plano: aviso com o motivo', async () => {
    const { results } = setup()
    render(<SaveStatusChip storageOffline={false} />)
    await act(async () => {
      for (const cb of results) cb({ ok: false, message: 'O backup do banco local falhou; nada mudou.' })
    })
    const chip = screen.getByRole('status')
    expect(chip.textContent).toContain('troca de banco cancelada')
    expect(chip.getAttribute('title')).toBe('O backup do banco local falhou; nada mudou.')
  })
})
