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

  it('planejamento: carrega config.planning.*, normaliza valor inválido e grava o padrão do que falta', async () => {
    kvFacade.readPersistedKvMany.mockResolvedValue(
      new Map([
        ['config.planning.model', JSON.stringify('modelo-que-saiu-do-catalogo')],
        ['config.planning.effort', JSON.stringify('xhigh')]
      ])
    )
    const { initializeConfigPersistence, updateConfig } = await import('./config')

    const loaded = await initializeConfigPersistence()
    expect(loaded.planning).toEqual({ model: 'auto', effort: 'xhigh' })

    kvFacade.writePersistedKv.mockClear()
    const next = await updateConfig({ planning: { model: 'claude-sonnet-5', effort: 'xhigh' } })
    expect(next.planning).toEqual({ model: 'claude-sonnet-5', effort: 'xhigh' })
    // Só o campo que mudou vai para o banco.
    expect(kvFacade.writePersistedKv.mock.calls).toEqual([['config.planning.model', JSON.stringify('claude-sonnet-5')]])
  })

  it('TypeSafe: a lista do Automático sobrevive a salvar e reabrir o app', async () => {
    // KV falso compartilhado entre as duas "execuções" do app.
    const kv = new Map<string, string>()
    kvFacade.writePersistedKv.mockImplementation(async (...args: unknown[]) => {
      kv.set(args[0] as string, args[1] as string)
      return undefined
    })
    kvFacade.readPersistedKvMany.mockImplementation(
      async (keys: string[]) => new Map(keys.map((key) => [key, kv.get(key) ?? null]))
    )

    const first = await import('./config')
    expect((await first.initializeConfigPersistence()).typesafe.allowedAutoModels).toEqual([])
    // O boot grava o padrão do campo que faltava: é isto que antes nunca ia ao banco.
    expect(kv.get('config.typesafe.allowedAutoModels')).toBe('[]')

    kvFacade.writePersistedKv.mockClear()
    const lista = ['claude-sonnet-5', 'claude-opus-5-5']
    const saved = await first.updateConfig({ typesafe: { ...first.loadConfig().typesafe, allowedAutoModels: lista } })
    expect(saved.typesafe.allowedAutoModels).toEqual(lista)
    // Só o campo que mudou vai para o banco, como JSON de array.
    expect(kvFacade.writePersistedKv.mock.calls).toEqual([['config.typesafe.allowedAutoModels', JSON.stringify(lista)]])

    // "Reinicia": módulo novo, mesmo banco.
    vi.resetModules()
    const second = await import('./config')
    expect((await second.initializeConfigPersistence()).typesafe.allowedAutoModels).toEqual(lista)
    expect(second.loadConfig().typesafe.allowedAutoModels).toEqual(lista)
    // A cópia devolvida não é o array do snapshot.
    second.loadConfig().typesafe.allowedAutoModels.push('mutado')
    expect(second.loadConfig().typesafe.allowedAutoModels).toEqual(lista)
  })

  it.each([
    ['texto', JSON.stringify('claude-sonnet-5')],
    ['objeto', JSON.stringify({ a: 1 })],
    ['número', '42'],
    ['null', 'null'],
    ['itens numéricos', JSON.stringify([1, 2])],
    ['item misto', JSON.stringify(['claude-sonnet-5', 3])],
    ['item vazio', JSON.stringify(['claude-sonnet-5', ''])]
  ])('TypeSafe: lista do Automático inválida (%s) cai em [] sem derrubar o boot', async (_nome, raw) => {
    kvFacade.readPersistedKvMany.mockResolvedValue(
      new Map([
        ['config.typesafe.allowedAutoModels', raw],
        ['config.typesafe.enabled', 'true']
      ])
    )
    const { initializeConfigPersistence } = await import('./config')

    const loaded = await initializeConfigPersistence()
    expect(loaded.typesafe.allowedAutoModels).toEqual([])
    // Os vizinhos do bloco continuam carregados.
    expect(loaded.typesafe.enabled).toBe(true)
  })

  it('depois de carregada, ensureConfigLoaded não lê de novo', async () => {
    kvFacade.readPersistedKvMany.mockResolvedValue(new Map())
    const { ensureConfigLoaded } = await import('./config')

    await ensureConfigLoaded()
    await ensureConfigLoaded()

    expect(kvFacade.readPersistedKvMany).toHaveBeenCalledTimes(1)
  })
})
