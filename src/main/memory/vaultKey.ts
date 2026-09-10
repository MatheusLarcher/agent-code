import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SecureStorageAdapter } from '../persistence/bootstrapStore'
import { readPersistedKv, writePersistedKv } from '../persistence/kvFacade'

/** Chave do cofre, no banco do Agent Code. */
export const VAULT_KEY_ID = 'agentcode.secret-vault-key.v1'
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

/**
 * Criptografia do cofre com chave própria, guardada no banco do Agent Code.
 *
 * NÃO é o `safeStorage` do sistema operacional. A diferença importa e é uma
 * escolha explícita do usuário: aqui a chave mora ao lado do texto cifrado, então
 * quem tem o arquivo do banco consegue abrir as senhas. O que isto entrega é que
 * a senha nunca fica em texto puro no disco nem em backup/sincronização — não
 * proteção contra alguém com acesso à máquina.
 *
 * AES-256-GCM (não CBC): o GCM autentica, então texto cifrado adulterado falha
 * na abertura em vez de devolver lixo silenciosamente.
 */
export function createDatabaseSecureStorage(): SecureStorageAdapter {
  return {
    // A chave é criada sob demanda; a única forma de não estar disponível é o
    // banco estar offline, e aí o cofre precisa falhar fechado.
    isEncryptionAvailable(): boolean {
      try {
        return vaultKey().length === KEY_BYTES
      } catch {
        return false
      }
    },
    encryptString(value: string): Buffer {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, vaultKey(), iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      // iv | tag | corpo — tudo num buffer só, para caber no contrato do adaptador.
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(value: Buffer): string {
      if (!Buffer.isBuffer(value) || value.length <= IV_BYTES + TAG_BYTES) {
        throw new Error('Texto cifrado do cofre é inválido.')
      }
      const iv = value.subarray(0, IV_BYTES)
      const tag = value.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
      const decipher = createDecipheriv(ALGORITHM, vaultKey(), iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([
        decipher.update(value.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final()
      ]).toString('utf8')
    }
  }
}

let cached: Buffer | null = null

/**
 * Carrega a chave do banco (criando na primeira vez) e a mantém em memória.
 *
 * O cache não é otimização, é necessidade: o cofre cifra dentro de um único
 * turno de JS (é assim que ele garante que o interruptor não muda no meio da
 * gravação), e o KV é assíncrono. Então a chave é resolvida ANTES, aqui.
 *
 * Chamar de novo ao trocar a pasta de dados é obrigatório — a chave do banco
 * antigo cifraria segredo no banco novo, e o erro só apareceria depois, na
 * forma de uma senha que não abre mais.
 */
export async function loadVaultKey(): Promise<void> {
  const stored = await readPersistedKv(VAULT_KEY_ID)
  if (stored) {
    const key = Buffer.from(stored, 'base64')
    // Chave corrompida/truncada: gerar outra por cima tornaria todo segredo já
    // salvo indecifrável sem avisar. Melhor recusar e deixar o erro aparecer.
    if (key.length !== KEY_BYTES) throw new Error('Chave do cofre inválida no banco.')
    cached = key
    return
  }
  const key = randomBytes(KEY_BYTES)
  await writePersistedKv(VAULT_KEY_ID, key.toString('base64'))
  cached = key
}

/** Esquece a chave carregada (troca de pasta de dados / backend offline). */
export function forgetVaultKey(): void {
  cached = null
}

function vaultKey(): Buffer {
  if (!cached) throw new Error('Chave do cofre não carregada.')
  return cached
}
