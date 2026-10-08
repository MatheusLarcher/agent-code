// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RestartGuardStatus } from './appRestart'
import { cloudToolDeps, configureCloudTool } from './cloudTool'
import type { DatabaseBackups } from './persistence/backup/databaseBackups'
import { createStorageSwitchWiring, type StorageSwitchWiringDeps } from './storageSwitchWiring'

const switchCloud = vi.hoisted(() => vi.fn(async () => ({ message: 'Nuvem ligada. O app vai reiniciar.' })))
vi.mock('./persistence/backup/cloudSwitch', () => ({ switchCloud, inspectCloud: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  configureCloudTool(null)
  switchCloud.mockClear()
})

function setup(guards: Array<Partial<RestartGuardStatus>>) {
  let call = 0
  const deps: StorageSwitchWiringDeps = {
    lifecycle: { exclusive: vi.fn(), status: vi.fn(), postgresSettings: vi.fn(), testPostgres: vi.fn() } as never,
    backups: {} as DatabaseBackups,
    appVersion: 't',
    guard: () => ({ idle: true, blockedBy: null, sessions: 1, at: '', ...(guards[Math.min(call++, guards.length - 1)] ?? {}) }),
    flushRenderer: vi.fn(async () => undefined),
    flushQueues: vi.fn(async () => ({ conversations: false, outbox: true })),
    onlyRefusedLeft: vi.fn(() => true),
    stopSessions: vi.fn(async () => undefined),
    readSecret: vi.fn(async () => null),
    send: vi.fn(),
    relaunch: vi.fn(),
    log: vi.fn()
  }
  return { deps, wiring: createStorageSwitchWiring(deps) }
}

describe('fiação da troca de banco', () => {
  it('a troca pedida pela ferramenta espera os turnos terminarem, avisa o resultado e reinicia', async () => {
    vi.useFakeTimers()
    const { deps } = setup([{ idle: false, blockedBy: 'Conversa ocupada: c1.' }, { idle: false }, { idle: true }])
    cloudToolDeps(() => ({ ok: true, message: '' }))!.schedule({ action: 'ligar', keep: 'local' })
    await vi.advanceTimersByTimeAsync(400)
    expect(switchCloud).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_200)
    expect(switchCloud).toHaveBeenCalledWith(expect.anything(), { action: 'ligar', keep: 'local' })
    expect(deps.send).toHaveBeenCalledWith('storage:transition-result', { ok: true, message: 'Nuvem ligada. O app vai reiniciar.' })
    expect(deps.relaunch).toHaveBeenCalled()
  })

  it('a troca que falha avisa a tela (o agente já terminou o turno) e não reinicia', async () => {
    const { deps } = setup([{ idle: true }])
    switchCloud.mockRejectedValueOnce(new Error('pg_dump falhou: disco cheio'))
    cloudToolDeps(() => ({ ok: true, message: '' }))!.schedule({ action: 'desligar', keep: 'nuvem' })
    await vi.waitFor(() =>
      expect(deps.send).toHaveBeenCalledWith('storage:transition-result', {
        ok: false,
        message: 'A troca de banco pedida pelo agente não aconteceu: pg_dump falhou: disco cheio'
      })
    )
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('a drenagem aceita quando só sobrou recusa definitiva; a guarda recusa com conversa ocupada', async () => {
    const { wiring } = setup([{ idle: false, blockedBy: 'Conversa ocupada: c9.' }])
    await expect(wiring.switchDeps.drain()).resolves.toBe(true)
    expect(() => wiring.switchDeps.assertIdle()).toThrow(/Conversa ocupada: c9\..*todas as conversas paradas/)
  })
})
