import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { readPersistedKv, writePersistedKv } from '../persistence/kvFacade'

/** Cópia do cofre inteiro (chave + segredos cifrados) dentro do banco. */
export const VAULT_MIRROR_KEY = 'agentcode.secret-vault-mirror.v1'

/**
 * Espelho do cofre no banco, para que NENHUMA senha se perca numa migração.
 *
 * O arquivo e o banco guardam a mesma coisa — chave e segredos cifrados —, e
 * qualquer um dos dois sozinho reabre tudo:
 *
 * - levaram só o `agent-code.db`  → o espelho restaura o arquivo;
 * - o `agent-code.db` corrompeu   → o arquivo continua íntegro (já corrompeu 3×
 *                                    na máquina deste usuário);
 * - levaram a pasta inteira       → os dois vão juntos e continuam iguais.
 *
 * A redundância é o ponto: o usuário disse que não pode perder senha em
 * migração, e duas cópias em lugares independentes é o que sustenta isso.
 * Não muda a força da criptografia — chave e cifrado já viajavam juntos no
 * arquivo, e ele aceitou explicitamente esse compromisso.
 */
export async function mirrorVaultToDatabase(vaultFile: string): Promise<void> {
  try {
    if (!existsSync(vaultFile)) return
    const envelope = readFileSync(vaultFile, 'utf8')
    // Grava só o que é um envelope válido: espelhar lixo apagaria a boa cópia.
    if (!isVaultEnvelope(envelope)) return
    if ((await readPersistedKv(VAULT_MIRROR_KEY)) === envelope) return // já idêntico
    await writePersistedKv(VAULT_MIRROR_KEY, envelope)
  } catch {
    // Espelhar é redundância: falhar aqui não pode derrubar a gravação que já
    // aconteceu no arquivo. A próxima gravação tenta de novo.
  }
}

/**
 * Reconstrói o arquivo do cofre a partir do banco quando ele falta ou está
 * ilegível. É o caminho da migração "levei só o banco".
 *
 * Devolve o que aconteceu, para o chamador registrar — restauração silenciosa
 * de credencial é o tipo de coisa que ninguém quer descobrir depois.
 */
export async function restoreVaultFromDatabase(
  vaultFile: string
): Promise<'restored' | 'kept-existing' | 'no-mirror' | 'failed'> {
  try {
    if (existsSync(vaultFile) && isVaultEnvelope(safeRead(vaultFile))) return 'kept-existing'
    const mirror = await readPersistedKv(VAULT_MIRROR_KEY)
    if (!mirror || !isVaultEnvelope(mirror)) return 'no-mirror'
    mkdirSync(dirname(vaultFile), { recursive: true, mode: 0o700 })
    // Arquivo existente e ilegível vai para o lado, nunca é sobrescrito: pode
    // conter um segredo que o espelho ainda não tem.
    if (existsSync(vaultFile)) renameSync(vaultFile, `${vaultFile}.corrupt-${Date.now()}`)
    writeFileSync(vaultFile, mirror, { encoding: 'utf8', mode: 0o600 })
    return 'restored'
  } catch {
    return 'failed'
  }
}

function safeRead(file: string): string {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

/** Forma mínima: versão, chave de 32 bytes e lista de registros. */
function isVaultEnvelope(text: string): boolean {
  try {
    const data = JSON.parse(text) as { version?: unknown; key?: unknown; records?: unknown }
    return data?.version === 2 && typeof data.key === 'string' &&
      Buffer.from(data.key, 'base64').length === 32 && Array.isArray(data.records)
  } catch {
    return false
  }
}
