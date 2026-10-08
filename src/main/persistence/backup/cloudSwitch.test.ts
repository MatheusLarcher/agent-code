// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PostgresConnectionDraft } from '../../../shared/ipc'
import type { BootstrapStore } from '../bootstrapStore'
import type { TransitionHost } from '../storageTransitions'
import type { StorageStatus } from '../types'
import type { BackupMeta } from './backupFiles'
import { switchCloud, switchOptions } from './cloudSwitch'
import type { StorageSwitchDeps } from './switchSupport'

const testConnection = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../postgresProvisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../postgresProvisioning')>()),
  testPostgresConnection: testConnection
}))

const localDraft: PostgresConnectionDraft = { host: '127.0.0.1', port: 45432, user: 'agentcode', password: 'l', maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '' }
const cloudDraft: PostgresConnectionDraft = { host: 'nuvem.exemplo', port: 6502, user: 'app', password: 'n', maintenanceDatabase: 'postgres', tlsMode: 'disable', ca: '' }
const ready: StorageStatus = { backend: 'postgres', state: 'postgres-ready', writable: true, installationId: 'i', targetDatabase: 'agent-code', hasPassword: true }

beforeEach(() => testConnection.mockClear())

function setup(target: 'local' | 'cloud', options: { createdDatabase?: boolean; status?: StorageStatus } = {}) {
  const calls: string[] = []
  let status: StorageStatus = options.status ?? { ...ready }
  const bootstrap = {
    load: async () => ({ backend: 'postgres', postgresTarget: target }),
    connection: async (raw?: PostgresConnectionDraft) => raw ?? cloudDraft,
    saveConnection: vi.fn(async (raw: PostgresConnectionDraft) => {
      calls.push(`salva a conexão ${raw.host}`)
    }),
    selectPostgresTarget: vi.fn(async (next: string) => {
      calls.push(`bootstrap → ${next}`)
    })
  }
  const host = {
    installationId: 'i',
    appVersion: 't',
    status: () => status,
    active: () => null,
    location: () => null,
    bootstrap: () => bootstrap as unknown as BootstrapStore,
    publish: (backend, state, writable, hasPassword) => {
      status = { ...status, backend, state, writable, hasPassword: Boolean(hasPassword) }
      if (state === 'switching-postgres') calls.push(`troca ${writable ? 'gravável' : 'retida'}`)
    },
    step: () => undefined,
    bind: () => undefined,
    createPostgresRepository: () => {
      throw new Error('não usado')
    },
    resolveDraft: async (raw) => raw,
    localDraft: async () => {
      calls.push('sobe o local')
      return localDraft
    },
    detach: async () => undefined,
    reopen: async () => undefined
  } satisfies TransitionHost
  const deps: StorageSwitchDeps = {
    lifecycle: { exclusive: (work) => work(host) as never },
    backups: {
      create: vi.fn(async (source, reason) => {
        calls.push(`backup ${source.side} ${reason}`)
        return { file: `x_${source.side}_${reason}.dump` } as BackupMeta
      }),
      dumpForTransfer: vi.fn(async (source) => {
        calls.push(`pg_dump ${source.side}`)
        return { file: 'C:/tmp/troca.dump', counts: { tables: { conversations: 5 }, conversations: 5, lastUpdate: null }, serverVersion: '18.6' }
      }),
      restoreInto: vi.fn(async (_file: string, draft: PostgresConnectionDraft) => {
        calls.push(`pg_restore → ${draft.host}`)
        return '36 tabelas conferidas, todas iguais'
      }),
      read: vi.fn(),
      cancelDaily: vi.fn(async () => undefined)
    },
    installationId: () => 'i',
    appVersion: 't',
    assertIdle: vi.fn(),
    drain: vi.fn(async () => {
      calls.push('drena')
      return true
    }),
    stopSessions: vi.fn(async () => {
      calls.push('encerra sessões')
    }),
    log: () => undefined,
    provision: async (draft) => {
      calls.push(`banco existe em ${draft.host}`)
      return { createdDatabase: options.createdDatabase ?? false }
    }
  }
  return { calls, deps, bootstrap, status: () => status }
}

describe('troca local ↔ nuvem', () => {
  it('ligar mantendo os locais: backup da nuvem ANTES, cópia local → nuvem conferida, e só então o bootstrap', async () => {
    const { calls, deps } = setup('local')
    const outcome = await switchCloud(deps, { action: 'ligar', keep: 'local', draft: cloudDraft })
    expect(testConnection).toHaveBeenCalledWith(cloudDraft)
    expect(calls).toEqual([
      'troca gravável',
      'sobe o local',
      'troca gravável',
      'drena',
      'troca retida',
      'encerra sessões',
      'banco existe em nuvem.exemplo',
      'backup nuvem antes-da-troca',
      'pg_dump local',
      'pg_restore → nuvem.exemplo',
      'salva a conexão nuvem.exemplo',
      'bootstrap → cloud'
    ])
    expect(deps.backups.restoreInto).toHaveBeenCalledWith('C:/tmp/troca.dump', cloudDraft, { conversations: 5 })
    expect(outcome.message).toMatch(/Nuvem ligada, mantendo os dados locais \(36 tabelas conferidas.*x_nuvem_antes-da-troca\.dump\)/)
  })

  it('ligar mantendo a nuvem: nada é copiado nem sobrescrito (o local fica guardado)', async () => {
    const { calls, deps } = setup('local')
    await switchCloud(deps, { action: 'ligar', keep: 'nuvem', draft: cloudDraft })
    expect(deps.backups.create).not.toHaveBeenCalled()
    expect(deps.backups.dumpForTransfer).not.toHaveBeenCalled()
    expect(calls).not.toContain('sobe o local')
    expect(calls.at(-1)).toBe('bootstrap → cloud')
  })

  it('desligar mantendo a nuvem: backup do local, cópia nuvem → local; banco novo não precisa de backup', async () => {
    const { calls, deps } = setup('cloud', { createdDatabase: true })
    await switchCloud(deps, { action: 'desligar', keep: 'nuvem' })
    expect(calls).toContain('pg_dump nuvem')
    expect(calls).toContain('pg_restore → 127.0.0.1')
    expect(deps.backups.create).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('bootstrap → local')
  })

  it('desligar mantendo os locais com a nuvem fora do ar: nem testa a nuvem; a fila que não drenou vai para o local', async () => {
    const offline: StorageStatus = { ...ready, state: 'postgres-offline', writable: false }
    const { calls, deps } = setup('cloud', { status: offline })
    vi.mocked(deps.drain).mockResolvedValueOnce(false)
    await switchCloud(deps, { action: 'desligar', keep: 'local' })
    expect(testConnection).not.toHaveBeenCalled()
    expect(deps.backups.dumpForTransfer).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe('bootstrap → local')
  })

  it('o backup do lado sobrescrito falhou: a troca é cancelada e nada muda', async () => {
    const { deps, bootstrap, status } = setup('local')
    vi.mocked(deps.backups.create).mockRejectedValueOnce(new Error('pg_dump falhou (código 1): disco cheio'))
    await expect(switchCloud(deps, { action: 'ligar', keep: 'local', draft: cloudDraft })).rejects.toThrow('disco cheio')
    expect(deps.backups.dumpForTransfer).not.toHaveBeenCalled()
    expect(deps.backups.restoreInto).not.toHaveBeenCalled()
    expect(bootstrap.selectPostgresTarget).not.toHaveBeenCalled()
    expect(bootstrap.saveConnection).not.toHaveBeenCalled()
    expect(status()).toMatchObject({ state: 'postgres-ready', writable: true })
  })

  it('conversa no meio de um turno: recusada antes de tocar em qualquer banco', async () => {
    const { calls, deps } = setup('local')
    vi.mocked(deps.assertIdle).mockImplementation(() => {
      throw new Error('Há agente trabalhando agora')
    })
    await expect(switchCloud(deps, { action: 'ligar', keep: 'local', draft: cloudDraft })).rejects.toThrow('Há agente trabalhando agora')
    expect(calls).toEqual([])
    expect(testConnection).not.toHaveBeenCalled()
  })

  it('ação que não cabe no estado de agora é recusada', async () => {
    await expect(switchCloud(setup('cloud').deps, { action: 'ligar', keep: 'local' })).rejects.toThrow('A nuvem já está ligada.')
    await expect(switchCloud(setup('local').deps, { action: 'desligar', keep: 'local' })).rejects.toThrow('A nuvem já está desligada.')
  })

  it('o diálogo explica o que cada escolha faz com cada lado', () => {
    expect(switchOptions('ligar', { side: 'nuvem', reachable: true, exists: true, conversations: 9, lastUpdate: null, serverVersion: '16.4' })).toMatchObject([
      { keep: 'local', copies: true, overwrites: 'nuvem' },
      { keep: 'nuvem', copies: false, overwrites: null }
    ])
    expect(switchOptions('desligar', { side: 'nuvem', reachable: true, exists: true, conversations: 9, lastUpdate: null, serverVersion: '18.6' })).toMatchObject([
      { keep: 'nuvem', copies: true, overwrites: 'local' },
      { keep: 'local', copies: false, overwrites: null }
    ])
  })
})
