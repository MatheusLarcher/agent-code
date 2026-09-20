// @vitest-environment node
// Main-process code: same reasoning as config.keys.test.ts — needs the node
// env (config → store → node:sqlite), and mocks electron before importing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', getAppPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

const kvFacade = vi.hoisted(() => ({
  readPersistedKvMany: vi.fn(),
  writePersistedKv: vi.fn(async () => undefined)
}))
vi.mock('./persistence/kvFacade', () => kvFacade)
vi.mock('./store', () => ({ kvGet: () => null }))

beforeEach(() => {
  vi.resetModules()
  kvFacade.readPersistedKvMany.mockReset()
  kvFacade.writePersistedKv.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Regressão da corrida de boot: `configGet`/`typesafe:is-configured` podem
 * chegar assim que `waitForStorageReady()` resolve no renderer — antes de o
 * próprio boot terminar `initializeConfigPersistence()`. Sem esperar por ela,
 * `loadConfig()` caía no fallback local (`loadLegacyConfig`) e reportava
 * TypeSafe/voz "desativados" mesmo já configurados, até algo pedir a config
 * de novo depois que o boot terminasse.
 */
describe('race de boot da config persistida', () => {
  it('ensureConfigLoaded espera a leitura em vez de deixar loadConfig no fallback local', async () => {
    let resolveRead!: (value: Map<string, string | null>) => void
    const pending = new Promise<Map<string, string | null>>((resolve) => {
      resolveRead = resolve
    })
    kvFacade.readPersistedKvMany.mockReturnValue(pending)

    const { ensureConfigLoaded, loadConfig } = await import('./config')

    const waiting = ensureConfigLoaded()
    // Antes da leitura terminar, é EXATAMENTE o bug: o fallback local reporta
    // desativado mesmo que a config real (ainda não carregada) diga ativado.
    expect(loadConfig().typesafe.enabled).toBe(false)

    resolveRead(new Map([['config.typesafe.enabled', 'true']]))
    await waiting

    expect(loadConfig().typesafe.enabled).toBe(true)
  })

  it('initializeConfigPersistence roda só uma vez mesmo com chamadas concorrentes', async () => {
    kvFacade.readPersistedKvMany.mockResolvedValue(new Map())
    const { initializeConfigPersistence } = await import('./config')

    await Promise.all([
      initializeConfigPersistence(),
      initializeConfigPersistence(),
      initializeConfigPersistence()
    ])

    expect(kvFacade.readPersistedKvMany).toHaveBeenCalledTimes(1)
  })

  it('depois de carregada, ensureConfigLoaded não lê de novo', async () => {
    kvFacade.readPersistedKvMany.mockResolvedValue(new Map())
    const { ensureConfigLoaded } = await import('./config')

    await ensureConfigLoaded()
    await ensureConfigLoaded()

    expect(kvFacade.readPersistedKvMany).toHaveBeenCalledTimes(1)
  })
})
