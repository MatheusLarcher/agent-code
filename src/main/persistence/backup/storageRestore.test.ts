// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import type { BootstrapStore } from '../bootstrapStore'
import type { TransitionHost } from '../storageTransitions'
import type { StorageStatus } from '../types'
import type { BackupMeta } from './backupFiles'
import { restoreBackup } from './storageRestore'
import type { StorageSwitchDeps } from './switchSupport'

const localDraft: PostgresConnectionDraft = { host: '127.0.0.1', port: 45432, user: 'agentcode', password: 'x', maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '' }
const cloudDraft: PostgresConnectionDraft = { ...localDraft, host: 'nuvem.exemplo', port: 6502, user: 'app' }
const ready: StorageStatus = { backend: 'postgres', state: 'postgres-ready', writable: true, installationId: 'i', targetDatabase: 'agent-code', hasPassword: true }

function setup(target: 'local' | 'cloud' = 'local') {
  const calls: string[] = []
  let status: StorageStatus = { ...ready }
  const host: TransitionHost = {
    installationId: 'i',
    appVersion: 't',
    status: () => status,
    active: () => null,
    location: () => null,
    bootstrap: () => ({ load: async () => ({ backend: 'postgres', postgresTarget: target }), connection: async () => cloudDraft }) as unknown as BootstrapStore,
    publish: (backend, state, writable, hasPassword) => {
      status = { ...status, backend, state, writable, hasPassword: Boolean(hasPassword) }
      calls.push(`status ${state} ${writable ? 'gravável' : 'retido'}`)
    },
    step: () => undefined,
    bind: () => undefined,
    createPostgresRepository: () => {
      throw new Error('não usado')
    },
    resolveDraft: async (raw) => raw,
    localDraft: async () => localDraft,
    detach: async () => {
      calls.push('solta o banco em uso')
    },
    reopen: async () => {
      calls.push('reabre')
      status = { ...ready }
    }
  }
  const meta = { file: '2026-10-08_0010_local_diario.dump', createdAt: '2026-10-08T03:10:00.000Z', tables: { conversations: 2 } } as unknown as BackupMeta
  const deps: StorageSwitchDeps = {
    lifecycle: { exclusive: (work) => work(host) as never },
    backups: {
      create: vi.fn(async (source, reason) => {
        calls.push(`backup ${source.side} ${reason}`)
        return { file: '2026-10-08_0011_local_antes-da-restauracao.dump' } as BackupMeta
      }),
      dumpForTransfer: vi.fn(),
      restoreInto: vi.fn(async (path: string, draft: PostgresConnectionDraft) => {
        calls.push(`pg_restore ${path} → ${draft.host}`)
        return '2 tabelas conferidas, todas iguais'
      }),
      read: vi.fn(async (file: string) => ({ path: `B:/backups/${file}`, meta })),
      cancelDaily: vi.fn(async () => {
        calls.push('para o diário')
      })
    },
    installationId: () => 'i',
    appVersion: 't',
    assertIdle: vi.fn(),
    drain: vi.fn(async () => {
      calls.push('drena a fila')
      return true
    }),
    stopSessions: vi.fn(async () => {
      calls.push('encerra sessões')
    }),
    log: () => undefined,
    provision: async (draft) => {
      calls.push(`banco existe em ${draft.host}`)
      return { createdDatabase: false }
    }
  }
  return { calls, deps, status: () => status }
}

describe('restaurar um backup', () => {
  it('no banco em uso: drena, retém, backup do estado atual ANTES, restaura e pede o reinício', async () => {
    const { calls, deps } = setup()
    const outcome = await restoreBackup(deps, { file: '2026-10-08_0010_local_diario.dump', target: 'local' })
    expect(calls).toEqual([
      'para o diário',
      'status restoring-postgres gravável',
      'drena a fila',
      'status restoring-postgres retido',
      'encerra sessões',
      'banco existe em 127.0.0.1',
      'backup local antes-da-restauracao',
      'solta o banco em uso',
      'pg_restore B:/backups/2026-10-08_0010_local_diario.dump → 127.0.0.1'
    ])
    expect(deps.backups.restoreInto).toHaveBeenCalledWith(expect.any(String), localDraft, { conversations: 2 })
    expect(outcome.relaunch).toBe(true)
    expect(outcome.message).toContain('2026-10-08_0011_local_antes-da-restauracao.dump')
  })

  it('backup do destino falhou: nada é restaurado e o banco em uso volta a aceitar gravação', async () => {
    const { calls, deps, status } = setup()
    vi.mocked(deps.backups.create).mockRejectedValueOnce(new Error('pg_dump falhou'))
    await expect(restoreBackup(deps, { file: 'x.dump', target: 'local' })).rejects.toThrow('pg_dump falhou')
    expect(deps.backups.restoreInto).not.toHaveBeenCalled()
    expect(calls).not.toContain('solta o banco em uso')
    expect(status()).toMatchObject({ state: 'postgres-ready', writable: true })
  })

  it('pg_restore falhou depois de soltar o banco: o banco (intacto, transação única) reabre', async () => {
    const { calls, deps, status } = setup()
    vi.mocked(deps.backups.restoreInto).mockRejectedValueOnce(new Error('pg_restore falhou'))
    await expect(restoreBackup(deps, { file: 'x.dump', target: 'local' })).rejects.toThrow('pg_restore falhou')
    expect(calls.at(-1)).toBe('reabre')
    expect(status()).toMatchObject({ state: 'postgres-ready', writable: true })
  })

  it('conversa no meio de um turno: recusada antes de qualquer coisa', async () => {
    const { calls, deps } = setup()
    vi.mocked(deps.assertIdle).mockImplementation(() => {
      throw new Error('Há agente trabalhando agora')
    })
    await expect(restoreBackup(deps, { file: 'x.dump', target: 'local' })).rejects.toThrow('Há agente trabalhando agora')
    expect(calls).toEqual([])
  })

  it('a fila não drenou: cancelada sem backup nem cópia', async () => {
    const { deps, status } = setup()
    vi.mocked(deps.drain).mockResolvedValueOnce(false)
    await expect(restoreBackup(deps, { file: 'x.dump', target: 'local' })).rejects.toThrow(/fila de gravação/)
    expect(deps.backups.create).not.toHaveBeenCalled()
    expect(status()).toMatchObject({ state: 'postgres-ready', writable: true })
  })

  it('no lado que NÃO está em uso (nuvem ligada, destino local): sem drenar nem reiniciar', async () => {
    const { calls, deps, status } = setup('cloud')
    const outcome = await restoreBackup(deps, { file: 'x.dump', target: 'local' })
    expect(outcome.relaunch).toBe(false)
    expect(calls).not.toContain('drena a fila')
    expect(calls).not.toContain('solta o banco em uso')
    expect(calls).toContain('backup local antes-da-restauracao')
    expect(status()).toMatchObject({ state: 'postgres-ready', writable: true })
  })

  it('destino nuvem com a nuvem desligada é recusado', async () => {
    const { deps } = setup('local')
    await expect(restoreBackup(deps, { file: 'x.dump', target: 'nuvem' })).rejects.toThrow(/nuvem não está ligada/)
    expect(deps.backups.create).not.toHaveBeenCalled()
  })
})
