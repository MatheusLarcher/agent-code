// @vitest-environment node
// Incidente (25/11/2026): o `Local State` do Electron foi recriado, a chave de
// cifra mudou e o `config.chromeBridgeToken` gravado antes não decifrava mais.
// Um campo só derrubava a leitura inteira e as Configurações travavam em
// "Campo de configuração persistido inválido".
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../shared/ipc'

vi.mock('electron', () => ({
  app: { getPath: () => '', getAppPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => {
      const text = value.toString('utf8')
      if (text.startsWith('CHAVE-ANTIGA')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return text
    }
  }
}))

const kvFacade = vi.hoisted(() => ({
  hasConfiguredKvRepository: vi.fn(() => true),
  readPersistedKvMany: vi.fn(),
  writePersistedKv: vi.fn(async () => undefined)
}))
vi.mock('./persistence/kvFacade', () => kvFacade)
vi.mock('./store', () => ({ kvGet: vi.fn(() => null) }))

function fakeKv(initial: [string, string][]): Map<string, string> {
  const kv = new Map(initial)
  kvFacade.writePersistedKv.mockImplementation(async (...args: unknown[]) => {
    kv.set(args[0] as string, args[1] as string)
    return undefined
  })
  kvFacade.readPersistedKvMany.mockImplementation(async (keys: string[]) => new Map(keys.map((k) => [k, kv.get(k) ?? null])))
  return kv
}

const sealed = (value: string): string => JSON.stringify({ safeStorage: Buffer.from(JSON.stringify(value), 'utf8').toString('base64') })
const sealedOldKey = JSON.stringify({ safeStorage: Buffer.from('CHAVE-ANTIGA:xyz', 'utf8').toString('base64') })

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('campo de configuração que não decifra', () => {
  it('não trava a leitura: o segredo fica vazio e o resto carrega', async () => {
    fakeKv([
      ['config.chromeBridgeToken', sealedOldKey],
      ['config.typesafe.apiKey', sealed('ts-real')],
      ['config.vigia.enabled', 'true']
    ])
    const { initializeConfigPersistence } = await import('./config')
    const cfg = await initializeConfigPersistence()
    expect(cfg.chromeBridgeToken).toBe('')
    expect(cfg.typesafe.apiKey).toBe('ts-real')
    expect(cfg.vigia.enabled).toBe(true)
  })

  it('não grava vazio por cima do segredo ilegível ao salvar outras coisas', async () => {
    const kv = fakeKv([['config.chromeBridgeToken', sealedOldKey]])
    const { initializeConfigPersistence, updateConfig, saveConfig, loadConfig } = await import('./config')
    await initializeConfigPersistence()
    await updateConfig({ vigia: { enabled: false } as AppConfig['vigia'] })
    await saveConfig(loadConfig())
    expect(kv.get('config.chromeBridgeToken')).toBe(sealedOldKey)
  })

  it('valor novo do usuário substitui o ilegível', async () => {
    const kv = fakeKv([['config.chromeBridgeToken', sealedOldKey]])
    const { initializeConfigPersistence, updateConfig } = await import('./config')
    await initializeConfigPersistence()
    await updateConfig({ chromeBridgeToken: 'novo' })
    expect(kv.get('config.chromeBridgeToken')).toBe(sealed('novo'))
  })

  it('campo comum corrompido volta ao padrão e é regravado', async () => {
    const kv = fakeKv([['config.vigia.enabled', '{quebrado']])
    const { initializeConfigPersistence } = await import('./config')
    await expect(initializeConfigPersistence()).resolves.toBeTruthy()
    expect(kv.get('config.vigia.enabled')).not.toBe('{quebrado')
  })
})
