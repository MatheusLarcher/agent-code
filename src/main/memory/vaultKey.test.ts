// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// KV falso no lugar do banco: guarda o que foi gravado para o teste inspecionar
// a chave como ela realmente fica persistida.
const store = new Map<string, string>()
vi.mock('../persistence/kvFacade', () => ({
  readPersistedKv: async (key: string) => store.get(key) ?? null,
  writePersistedKv: async (key: string, value: string) => void store.set(key, value)
}))

import { VAULT_KEY_ID, createDatabaseSecureStorage, forgetVaultKey, loadVaultKey } from './vaultKey'

beforeEach(() => {
  store.clear()
  forgetVaultKey()
})
afterEach(() => forgetVaultKey())

describe('cofre cifrado com chave do banco', () => {
  it('cria a chave na primeira carga e reusa a mesma depois', async () => {
    await loadVaultKey()
    const first = store.get(VAULT_KEY_ID)
    expect(Buffer.from(first!, 'base64')).toHaveLength(32)

    forgetVaultKey()
    await loadVaultKey()
    expect(store.get(VAULT_KEY_ID)).toBe(first)
  })

  it('vai e volta, e o texto cifrado não contém a senha', async () => {
    await loadVaultKey()
    const crypto = createDatabaseSecureStorage()
    const secret = 'senha-do-banco-2026'

    const sealed = crypto.encryptString(secret)
    // O ponto do recurso: o valor nunca fica legível em disco.
    expect(sealed.toString('utf8')).not.toContain(secret)
    expect(sealed.toString('base64')).not.toContain(Buffer.from(secret).toString('base64'))
    expect(crypto.decryptString(sealed)).toBe(secret)
  })

  it('cifra o mesmo valor de forma diferente a cada vez', async () => {
    await loadVaultKey()
    const crypto = createDatabaseSecureStorage()
    // IV aleatório: dois campos iguais não podem produzir o mesmo texto cifrado,
    // senão dá para saber que duas senhas guardadas são iguais sem abrir nenhuma.
    expect(crypto.encryptString('igual').toString('base64')).not.toBe(
      crypto.encryptString('igual').toString('base64')
    )
  })

  it('recusa texto cifrado adulterado em vez de devolver lixo', async () => {
    await loadVaultKey()
    const crypto = createDatabaseSecureStorage()
    const sealed = crypto.encryptString('senha')
    sealed[sealed.length - 1] ^= 0xff // um bit trocado no corpo

    // GCM autentica; é isso que transforma adulteração em erro, não em texto errado.
    expect(() => crypto.decryptString(sealed)).toThrow()
  })

  it('não abre com a chave de outro banco', async () => {
    await loadVaultKey()
    const sealed = createDatabaseSecureStorage().encryptString('senha')

    store.clear() // outra instalação, chave nova
    forgetVaultKey()
    await loadVaultKey()

    expect(() => createDatabaseSecureStorage().decryptString(sealed)).toThrow()
  })

  it('recusa chave corrompida no banco em vez de gerar outra por cima', async () => {
    store.set(VAULT_KEY_ID, Buffer.alloc(8).toString('base64'))
    // Gerar uma chave nova aqui tornaria todo segredo já salvo indecifrável, em
    // silêncio. Falhar é o comportamento que preserva o dado.
    await expect(loadVaultKey()).rejects.toThrow()
  })

  it('sem chave carregada, não cifra nem se diz disponível', async () => {
    const crypto = createDatabaseSecureStorage()
    expect(crypto.isEncryptionAvailable()).toBe(false)
    expect(() => crypto.encryptString('senha')).toThrow()
  })

  it('rejeita buffer curto demais para conter iv e tag', async () => {
    await loadVaultKey()
    expect(() => createDatabaseSecureStorage().decryptString(Buffer.alloc(8))).toThrow()
  })
})
