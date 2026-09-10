import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { SecureStorageAdapter } from '../persistence/bootstrapStore'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

export interface VaultCipher extends SecureStorageAdapter {
  /** A chave em base64, para o cofre gravar no MESMO arquivo dos segredos. */
  keyMaterial(): string
}

/**
 * Criptografia do cofre, com a chave guardada no PRÓPRIO arquivo do cofre.
 *
 * Por que junto e não no banco: a chave e o texto cifrado só valem em par. Em
 * lugares diferentes, migrar leva um e deixa o outro, e perder um dos dois é
 * perder a senha para sempre — não existe recuperação de AES sem chave. Num
 * arquivo só, dentro da pasta de dados (do lado do banco e das memórias),
 * copiar a pasta leva tudo, e uma corrupção do `agent-code.db` não alcança as
 * senhas. O `agent-code.db` deste usuário já corrompeu 3× — não é hipótese.
 *
 * O que isso protege: a senha nunca em texto puro no disco. O que NÃO protege:
 * quem tem o arquivo tem a chave. Foi a escolha explícita do usuário, que
 * preferiu não depender da criptografia do sistema operacional.
 *
 * AES-256-GCM (não CBC): autentica, então arquivo adulterado falha na abertura
 * em vez de devolver lixo silenciosamente.
 */
export function createVaultCipher(vaultFile: string): VaultCipher {
  let cached: Buffer | null = null

  // Lê a chave do arquivo do cofre; gera uma nova só quando ainda não existe
  // nenhuma. Síncrono de propósito: o cofre cifra dentro de um único turno de
  // JS, e é isso que garante que o interruptor não muda no meio da gravação.
  const key = (): Buffer => {
    if (cached) return cached
    cached = readKey(vaultFile) ?? randomBytes(KEY_BYTES)
    return cached
  }

  return {
    isEncryptionAvailable: () => {
      try { return key().length === KEY_BYTES } catch { return false }
    },
    keyMaterial: () => key().toString('base64'),
    encryptString: (value: string): Buffer => {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key(), iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      // iv | tag | corpo, num buffer só, para caber no contrato do adaptador.
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString: (value: Buffer): string => {
      if (!Buffer.isBuffer(value) || value.length <= IV_BYTES + TAG_BYTES) {
        throw new Error('Texto cifrado do cofre é inválido.')
      }
      const decipher = createDecipheriv(ALGORITHM, key(), value.subarray(0, IV_BYTES))
      decipher.setAuthTag(value.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
      return Buffer.concat([
        decipher.update(value.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final()
      ]).toString('utf8')
    }
  }
}

/**
 * Lê só o campo `key` do arquivo do cofre.
 *
 * Arquivo ausente devolve null (cofre novo). Arquivo presente mas com chave
 * ilegível/truncada TAMBÉM devolve null aqui — e é de propósito que isso não
 * gere uma chave nova por cima: quem escreve o arquivo é o cofre, que valida o
 * envelope inteiro e recusa dado inválido antes de gravar. Substituir a chave
 * silenciosamente tornaria todo segredo já salvo indecifrável.
 */
function readKey(vaultFile: string): Buffer | null {
  let parsed: { key?: unknown }
  try {
    parsed = JSON.parse(readFileSync(vaultFile, 'utf8')) as { key?: unknown }
  } catch {
    return null // ausente ou ilegível: o cofre trata o envelope inválido.
  }
  if (typeof parsed?.key !== 'string') return null
  const key = Buffer.from(parsed.key, 'base64')
  return key.length === KEY_BYTES ? key : null
}
