import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearRecreatedMark, globalConfigFile, isRecreatedDir } from './accountDirs'

/**
 * Cópia no banco da configuração de login de cada conta Claude extra — o
 * `.credentials.json` e o `oauthAccount` do `.claude.json` —, para recriar a
 * pasta da conta quando ela some.
 *
 * SEGREDO: o conteúdo vai CIFRADO pelo `safeStorage` do sistema (DPAPI no
 * Windows), o mesmo mecanismo do login do Codex (`codexAuth.ts`). Sem cifra
 * disponível, nada é gravado — nunca cai para texto puro. Não usa o cofre de
 * senhas (`secretVault`): o que está lá pode ir para o prompt do modelo.
 *
 * QUAL VENCE (pasta × banco, e dois dispositivos no mesmo PostgreSQL):
 * - vence a credencial com o `expiresAt` MAIOR — o refresh token rotaciona, e a
 *   mais nova é a que ainda vale. Empate: fica a que já está (nada é regravado);
 * - a chave é do escopo do dispositivo (`device_kv`, por instalação): outra
 *   máquina não lê nem grava a linha desta;
 * - cifra de outra máquina não abre aqui (DPAPI é por usuário/máquina): cópia
 *   que não decifra é ignorada e NUNCA substitui a pasta;
 * - a gravação relê o banco na hora e junta conta a conta pela mesma regra, então
 *   uma cópia mais nova gravada no meio do caminho não é trocada por uma velha.
 */

export const CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY = 'agentcode.claude-account-credentials.v1'

/** O pedaço do `safeStorage` do Electron que interessa (injetável nos testes). */
export interface CredentialCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  /**
   * `safeStorage.getSelectedStorageBackend()` (só existe no Linux). Sem chaveiro
   * o Electron cai no `basic_text`: `isEncryptionAvailable()` diz true, mas a
   * "cifra" é uma senha fixa embutida — só ofuscação.
   */
  storageBackend?(): string
}

/** Há cifra de verdade? Sem ela (inclusive o `basic_text` do Linux), nada de credencial é gravado. */
export function hasRealEncryption(cipher: CredentialCipher): boolean {
  if (!cipher.isEncryptionAvailable()) return false
  return cipher.storageBackend?.() !== 'basic_text'
}

/** Uma conta no banco. Só `enc` guarda segredo, e cifrado. */
export interface CredentialBackupEntry {
  enc: string
  /** `expiresAt` do access token (ms) — o critério de qual cópia vence. */
  expiresAt: number
  savedAt: number
}

export type CredentialBackups = Record<string, CredentialBackupEntry>

/** Credencial lida da pasta, ainda em claro — nunca sai deste processo. */
export interface FolderCredential {
  credentials: string
  expiresAt: number
  oauthAccount: Record<string, unknown> | null
}

const CREDENTIALS_FILE = '.credentials.json'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function jsonFile(path: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/** Credencial da pasta, ou null se não há login do claude.ai nela. */
export function readFolderCredential(dir: string): FolderCredential | null {
  const path = join(dir, CREDENTIALS_FILE)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  let block: Record<string, unknown> | null = null
  try {
    block = asRecord(asRecord(JSON.parse(text))?.claudeAiOauth)
  } catch {
    return null
  }
  if (!block || typeof block.accessToken !== 'string' || !block.accessToken) return null
  const expiresAt = typeof block.expiresAt === 'number' && Number.isFinite(block.expiresAt) ? block.expiresAt : 0
  const oauthAccount = asRecord(jsonFile(globalConfigFile(dir))?.oauthAccount)
  return { credentials: text, expiresAt, oauthAccount }
}

/**
 * Grava por arquivo temporário + rename: nunca deixa um arquivo pela metade. Se
 * o rename falhar (EPERM/EBUSY no Windows com o CLI segurando o arquivo), o
 * temporário sai e o erro sobe: quem chamou tenta de novo depois.
 */
function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Põe a credencial do banco na pasta. O `.claude.json` é criado se faltar; se
 * existe SEM `oauthAccount` (o CLI cria um assim ao rodar numa pasta vazia, ex.
 * a consulta de consumo), o `oauthAccount` é acrescentado e o resto fica como
 * está. Um `.claude.json` com outra identidade ou ilegível não é mexido.
 *
 * O `.claude.json` vai ANTES do `.credentials.json`: se ele falhar, a pasta fica
 * como estava (sem login, com o marcador de recriada) e a próxima passada repete.
 * Só com tudo gravado o marcador de pasta recriada sai.
 */
export function writeFolderCredential(dir: string, credential: FolderCredential): void {
  const config = globalConfigFile(dir)
  if (credential.oauthAccount) {
    const current = existsSync(config) ? jsonFile(config) : {}
    if (current && !asRecord(current.oauthAccount)) {
      writeAtomic(config, JSON.stringify({ ...current, oauthAccount: credential.oauthAccount }, null, 2))
    }
  }
  writeAtomic(join(dir, CREDENTIALS_FILE), credential.credentials)
  clearRecreatedMark(dir)
}

/**
 * Sem login na pasta: logout (o CLI tirou) ou pasta perdida/recriada? Decide pela
 * HISTÓRIA da pasta, não pelos arquivos — o `claude auth logout` (2.1.283) revoga
 * o refresh token, apaga o `.credentials.json` e tira o `oauthAccount` do
 * `.claude.json`, o mesmo estado da pasta recriada vazia em que o CLI rodou.
 * - `lost` (a cópia pode voltar): a pasta não existia, ou tem o marcador de
 *   recriada pelo app (`RECREATED_MARKER`); ou o `.credentials.json` está ilegível;
 * - `cleared` (logout: a cópia NÃO volta e sai do banco): a pasta já existia, sem
 *   o marcador, e não tem login — com ou sem o `.credentials.json`.
 */
export function missingLoginCause(dir: string, existed: boolean): 'cleared' | 'lost' {
  if (!existed || isRecreatedDir(dir)) return 'lost'
  const credentialsPath = join(dir, CREDENTIALS_FILE)
  if (existsSync(credentialsPath)) {
    try {
      JSON.parse(readFileSync(credentialsPath, 'utf8'))
    } catch {
      return 'lost'
    }
  }
  return 'cleared'
}

/** A credencial ainda serve? Token vivo, ou refresh token sem prazo vencido (como `readCredentialInfo`). */
export function credentialLive(credential: FolderCredential, now: number): boolean {
  if (credential.expiresAt > now) return true
  try {
    const block = asRecord(asRecord(JSON.parse(credential.credentials))?.claudeAiOauth)
    if (!block || typeof block.refreshToken !== 'string' || !block.refreshToken) return false
    const refreshExpiry = typeof block.refreshTokenExpiresAt === 'number' ? block.refreshTokenExpiresAt : 0
    return refreshExpiry === 0 || refreshExpiry > now
  } catch {
    return false
  }
}

export function encryptCredential(cipher: CredentialCipher, credential: FolderCredential, now: number): CredentialBackupEntry | null {
  if (!hasRealEncryption(cipher)) return null
  const payload = JSON.stringify({ credentials: credential.credentials, oauthAccount: credential.oauthAccount })
  const encrypted = cipher.encryptString(payload)
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) return null
  return { enc: encrypted.toString('base64'), expiresAt: credential.expiresAt, savedAt: now }
}

/** Decifra uma cópia; null se não abre (outra máquina, cifra indisponível, lixo). */
export function decryptCredential(cipher: CredentialCipher, entry: CredentialBackupEntry): FolderCredential | null {
  try {
    if (!cipher.isEncryptionAvailable()) return null
    const data = asRecord(JSON.parse(cipher.decryptString(Buffer.from(entry.enc, 'base64'))))
    if (!data || typeof data.credentials !== 'string') return null
    const block = asRecord(asRecord(JSON.parse(data.credentials))?.claudeAiOauth)
    if (!block || typeof block.accessToken !== 'string' || !block.accessToken) return null
    return { credentials: data.credentials, expiresAt: entry.expiresAt, oauthAccount: asRecord(data.oauthAccount) }
  } catch {
    return null
  }
}

function validEntry(value: unknown): value is CredentialBackupEntry {
  const entry = asRecord(value)
  return (
    !!entry &&
    typeof entry.enc === 'string' &&
    entry.enc.length > 0 &&
    typeof entry.expiresAt === 'number' &&
    Number.isFinite(entry.expiresAt) &&
    typeof entry.savedAt === 'number'
  )
}

export function parseBackups(raw: string | null): CredentialBackups {
  const out: CredentialBackups = {}
  let data: Record<string, unknown> | null = null
  try {
    data = raw ? asRecord(asRecord(JSON.parse(raw))?.accounts) : null
  } catch {
    data = null
  }
  for (const [id, entry] of Object.entries(data ?? {})) if (validEntry(entry)) out[id] = entry
  return out
}

/** A regra de qual vence: a de `expiresAt` maior; empate fica a atual. */
export function newer(candidate: CredentialBackupEntry, current: CredentialBackupEntry | undefined): boolean {
  return !current || candidate.expiresAt > current.expiresAt
}

export interface BackupStoreDeps {
  readKv: (key: string) => Promise<string | null>
  writeKv: (key: string, value: string) => Promise<void>
}

/**
 * Grava as cópias novas relendo o banco antes: junta conta a conta pela regra
 * de `newer`, então nunca troca uma cópia mais nova por uma mais velha.
 * `forget` tira contas removidas pelo usuário.
 */
export async function saveBackups(
  deps: BackupStoreDeps,
  updates: CredentialBackups,
  forget: readonly string[] = []
): Promise<{ written: string[]; removed: string[] }> {
  const current = parseBackups(await deps.readKv(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY))
  const written: string[] = []
  const gone = new Set(forget)
  for (const [id, entry] of Object.entries(updates)) {
    if (gone.has(id) || !newer(entry, current[id])) continue
    current[id] = entry
    written.push(id)
  }
  const removed = [...gone].filter((id) => id in current)
  for (const id of removed) delete current[id]
  if (!written.length && !removed.length) return { written: [], removed: [] }
  await deps.writeKv(CLAUDE_ACCOUNT_CREDENTIALS_KV_KEY, JSON.stringify({ version: 1, accounts: current }))
  return { written, removed }
}
