import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', getAppPath: () => '', getVersion: () => '0.0.0' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

const { CONFIG_PERSISTED_KEYS } = await import('./config')
const { isRegisteredPersistedKey } = await import('./persistence/keyRegistry')
const { PERSISTENCE_INVENTORY } = await import('./persistence/inventory')

/**
 * Regressão do boot invisível: `initializeConfigPersistence` lê campo por campo
 * e `persistedKeyDefinition` LANÇA para chave não registrada. Como isso roda
 * antes de `createWindow()`, um campo novo em `config.ts` sem entrada no
 * registro deixava o app subir sem janela nenhuma — processo vivo, nada na tela.
 */
describe('chaves persistidas da configuração', () => {
  it('registra todo campo de config no registro de chaves', () => {
    const missing = CONFIG_PERSISTED_KEYS.filter((key) => !isRegisteredPersistedKey(key))
    expect(missing).toEqual([])
  })

  it('mantém o inventário de app-config em dia com os campos', () => {
    const inventoried = PERSISTENCE_INVENTORY.find((item) => item.id === 'app-config')?.keys ?? []
    const missing = CONFIG_PERSISTED_KEYS.filter((key) => !inventoried.includes(key))
    expect(missing).toEqual([])
  })
})
