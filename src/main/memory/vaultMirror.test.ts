// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Banco falso: guarda o que foi espelhado, para o teste migrar "só o banco".
const db = new Map<string, string>()
vi.mock('../persistence/kvFacade', () => ({
  readPersistedKv: async (key: string) => db.get(key) ?? null,
  writePersistedKv: async (key: string, value: string) => void db.set(key, value)
}))

import { SecretVault, VAULT_FILENAME } from './secretVault'
import { createVaultCipher } from './vaultKey'
import { VAULT_MIRROR_KEY, mirrorVaultToDatabase, restoreVaultFromDatabase } from './vaultMirror'

const roots: string[] = []
beforeEach(() => db.clear())
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Uma máquina = uma pasta de dados com o cofre dentro. */
function machine(): { dir: string; file: string; vault: SecretVault } {
  const root = mkdtempSync(join(tmpdir(), 'agent-code-mirror-'))
  roots.push(root)
  const dir = join(root, 'vault')
  const file = join(dir, VAULT_FILENAME)
  const cipher = createVaultCipher(file)
  const vault = new SecretVault({
    directory: dir,
    enabled: () => true,
    secureStorage: cipher,
    keyMaterial: () => cipher.keyMaterial()
  })
  return { dir, file, vault }
}

function reopen(dir: string): SecretVault {
  const file = join(dir, VAULT_FILENAME)
  const cipher = createVaultCipher(file)
  return new SecretVault({
    directory: dir,
    enabled: () => true,
    secureStorage: cipher,
    keyMaterial: () => cipher.keyMaterial()
  })
}

describe('espelho do cofre no banco — nenhuma senha se perde na migração', () => {
  it('migrar SÓ o banco reabre todas as senhas', async () => {
    const origem = machine()
    await origem.vault.put('vps', 'senha-da-vps')
    await origem.vault.put('banco-prod', 'senha-do-banco')
    await mirrorVaultToDatabase(origem.file)

    // Outra máquina: nada em disco, só o banco veio junto.
    const destino = machine()
    expect(await restoreVaultFromDatabase(destino.file)).toBe('restored')

    const vault = reopen(destino.dir)
    expect(await vault.get('vps')).toBe('senha-da-vps')
    expect(await vault.get('banco-prod')).toBe('senha-do-banco')
  })

  it('migrar SÓ a pasta funciona sem o banco (o espelho é redundância, não requisito)', async () => {
    const origem = machine()
    await origem.vault.put('vps', 'senha-da-vps')
    const arquivo = readFileSync(origem.file)

    const destino = machine()
    await destino.vault.put('semente', 'x') // cria a pasta
    writeFileSync(destino.file, arquivo)
    db.clear() // banco novo, sem espelho nenhum

    expect(await reopen(destino.dir).get('vps')).toBe('senha-da-vps')
  })

  it('arquivo íntegro nunca é substituído pelo espelho', async () => {
    const { file, vault, dir } = machine()
    await vault.put('local', 'senha-local')
    db.set(VAULT_MIRROR_KEY, readFileSync(file, 'utf8')) // espelho antigo/qualquer
    await vault.put('mais-nova', 'senha-nova') // arquivo passa à frente

    expect(await restoreVaultFromDatabase(file)).toBe('kept-existing')
    // Restaurar por cima aqui apagaria a senha que só existe no arquivo.
    expect(await reopen(dir).get('mais-nova')).toBe('senha-nova')
  })

  it('arquivo corrompido é movido para o lado, não sobrescrito', async () => {
    const origem = machine()
    await origem.vault.put('vps', 'senha-da-vps')
    await mirrorVaultToDatabase(origem.file)

    writeFileSync(origem.file, '{ isso não é json')
    expect(await restoreVaultFromDatabase(origem.file)).toBe('restored')

    // O arquivo quebrado pode conter algo que o espelho não tem: preservar.
    const preservados = readdirSync(origem.dir).filter((name) => name.includes('.corrupt-'))
    expect(preservados).toHaveLength(1)
    expect(readFileSync(join(origem.dir, preservados[0]), 'utf8')).toBe('{ isso não é json')
    expect(await reopen(origem.dir).get('vps')).toBe('senha-da-vps')
  })

  it('apagar uma senha atualiza o espelho, senão ela ressuscitaria', async () => {
    const { file, vault, dir } = machine()
    await vault.put('some', 'vai-sumir')
    await vault.put('fica', 'permanece')
    await mirrorVaultToDatabase(file)

    await vault.deleteForManagement('some')
    await mirrorVaultToDatabase(file)

    rmSync(file)
    expect(await restoreVaultFromDatabase(file)).toBe('restored')
    const vaultRestaurado = reopen(dir)
    expect(await vaultRestaurado.get('some')).toBeNull()
    expect(await vaultRestaurado.get('fica')).toBe('permanece')
  })

  it('espelho inválido não sobrescreve nada, e lixo nunca é espelhado', async () => {
    const { file, dir, vault } = machine()
    await vault.put('a', '1')

    db.set(VAULT_MIRROR_KEY, 'não é envelope')
    rmSync(file)
    // Restaurar de um espelho quebrado criaria um cofre inutilizável.
    expect(await restoreVaultFromDatabase(file)).toBe('no-mirror')

    writeFileSync(file, '{ quebrado')
    db.delete(VAULT_MIRROR_KEY)
    await mirrorVaultToDatabase(file)
    expect(db.get(VAULT_MIRROR_KEY)).toBeUndefined()
    expect(dir).toBeTruthy()
  })

  it('sem cofre em disco e sem espelho, não inventa arquivo', async () => {
    const { file } = machine()
    expect(await restoreVaultFromDatabase(file)).toBe('no-mirror')
  })
})
