// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SecretVault, VAULT_FILENAME } from './secretVault'
import { createVaultCipher } from './vaultKey'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Um "computador": uma pasta de dados com o cofre dentro. */
function machine(): { dir: string; vault: SecretVault; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-code-vault-'))
  roots.push(root)
  const dir = join(root, 'vault')
  const file = join(dir, VAULT_FILENAME)
  const cipher = createVaultCipher(file)
  return {
    dir,
    file,
    vault: new SecretVault({
      directory: dir,
      enabled: () => true,
      secureStorage: cipher,
      keyMaterial: () => cipher.keyMaterial()
    })
  }
}

describe('cofre: chave e senhas no mesmo arquivo', () => {
  it('guarda e devolve a senha, sem deixá-la legível no arquivo', async () => {
    const { vault, file } = machine()
    await vault.put('banco-prod', 'senha-real-123')

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('senha-real-123')
    expect(await vault.get('banco-prod')).toBe('senha-real-123')
  })

  it('o arquivo carrega a chave junto: copiar para outra máquina abre a senha', async () => {
    const origem = machine()
    await origem.vault.put('vps', 'senha-da-vps')
    const copia = readFileSync(origem.file)

    // Outra máquina, outra pasta de dados, nenhum banco em comum.
    const destino = machine()
    destino.vault // força a criação da pasta antes de escrever o arquivo
    await destino.vault.put('temporaria', 'x')
    writeFileSync(destino.file, copia)

    // É ESTE o caso que a separação chave/senha quebrava: migrar levava a chave
    // e deixava a senha para trás (ou o contrário), e sem o par não há resgate.
    const migrado = machine()
    await migrado.vault.put('semente', 'y') // cria a pasta
    writeFileSync(migrado.file, copia)
    const cipherMigrado = createVaultCipher(migrado.file)
    const vaultMigrado = new SecretVault({
      directory: migrado.dir,
      enabled: () => true,
      secureStorage: cipherMigrado,
      keyMaterial: () => cipherMigrado.keyMaterial()
    })
    expect(await vaultMigrado.get('vps')).toBe('senha-da-vps')
  })

  it('apagar uma senha não descarta a chave das outras', async () => {
    const { vault, file } = machine()
    await vault.put('primeira', 'senha-1')
    await vault.put('segunda', 'senha-2')
    const chaveAntes = (JSON.parse(readFileSync(file, 'utf8')) as { key: string }).key

    await vault.deleteForManagement('primeira')

    // Regravar o envelope sem a chave transformaria o resto em lixo cifrado.
    expect((JSON.parse(readFileSync(file, 'utf8')) as { key: string }).key).toBe(chaveAntes)
    expect(await vault.get('segunda')).toBe('senha-2')
  })

  it('a chave não é trocada entre gravações', async () => {
    const { vault, file } = machine()
    await vault.put('a', '1')
    const primeira = (JSON.parse(readFileSync(file, 'utf8')) as { key: string }).key
    await vault.put('b', '2')

    expect((JSON.parse(readFileSync(file, 'utf8')) as { key: string }).key).toBe(primeira)
    expect(await vault.get('a')).toBe('1')
  })

  it('cifra o mesmo valor de forma diferente a cada vez', () => {
    const { file } = machine()
    const cipher = createVaultCipher(file)
    // IV aleatório: senhas iguais não podem gerar o mesmo texto cifrado, senão
    // dá para saber que dois campos são iguais sem abrir nenhum.
    expect(cipher.encryptString('igual').toString('base64'))
      .not.toBe(cipher.encryptString('igual').toString('base64'))
  })

  it('recusa texto cifrado adulterado em vez de devolver lixo', () => {
    const { file } = machine()
    const cipher = createVaultCipher(file)
    const sealed = cipher.encryptString('senha')
    sealed[sealed.length - 1] ^= 0xff

    expect(() => cipher.decryptString(sealed)).toThrow()
  })

  it('não abre com a chave de outro cofre', async () => {
    const origem = machine()
    await origem.vault.put('x', 'senha')
    const cifrado = (JSON.parse(readFileSync(origem.file, 'utf8')) as { records: Array<{ ciphertext: string }> })
      .records[0].ciphertext

    const outro = machine()
    await outro.vault.put('y', 'outra') // gera uma chave diferente
    expect(() => createVaultCipher(outro.file).decryptString(Buffer.from(cifrado, 'base64'))).toThrow()
  })

  it('arquivo com chave truncada é recusado, não regravado por cima', async () => {
    const { vault, file, dir } = machine()
    await vault.put('a', '1')
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...envelope, key: Buffer.alloc(8).toString('base64') }))

    // Gerar uma chave nova aqui apagaria o acesso a tudo que já está salvo.
    const cipher = createVaultCipher(file)
    const quebrado = new SecretVault({
      directory: dir,
      enabled: () => true,
      secureStorage: cipher,
      keyMaterial: () => cipher.keyMaterial()
    })
    await expect(quebrado.get('a')).rejects.toThrow()
    expect((JSON.parse(readFileSync(file, 'utf8')) as { key: string }).key).toHaveLength(12)
  })
})
