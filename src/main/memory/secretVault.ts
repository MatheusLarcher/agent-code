import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync,
  unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type { SecureStorageAdapter } from '../persistence/bootstrapStore'

const MAX_VALUE_BYTES = 64 * 1024
const MAX_CIPHERTEXT_BYTES = 128 * 1024
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_RECORDS = 1_000
const queues = new Map<string, Promise<unknown>>()
const messages = {
  DISABLED: 'Secret vault access is disabled.',
  INVALID_INPUT: 'Invalid secret vault input.',
  UNAVAILABLE: 'Secret vault encryption is unavailable.',
  CRYPTO_FAILED: 'Secret vault encryption operation failed.',
  INVALID_DATA: 'Secret vault data is invalid.',
  UNSAFE_PATH: 'Secret vault path is unsafe.',
  IO_FAILED: 'Secret vault storage operation failed.'
} as const

type ErrorCode = keyof typeof messages
export class SecretVaultError extends Error {
  constructor(readonly code: ErrorCode) {
    super(messages[code])
    this.name = 'SecretVaultError'
  }
}
export interface SecretMetadata { name: string; createdAt: string; updatedAt: string }
interface SecretRecord extends SecretMetadata { ciphertext: string }
interface Envelope { version: 1; records: SecretRecord[] }
export interface SecretVaultOptions {
  directory: string
  enabled: () => boolean
  secureStorage: SecureStorageAdapter
  /** Receives only successful action/name pairs. Never pass secret values to audit sinks. */
  audit?: (event: { action: 'get' | 'put' | 'delete'; name: string }) => void
}

function validName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)
}
function validValue(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_VALUE_BYTES
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}
function safeError(error: unknown): SecretVaultError {
  return error instanceof SecretVaultError ? error : new SecretVaultError('IO_FAILED')
}

/**
 * Device-local, encrypted-at-rest storage, deliberately outside generic KV/PG transfer.
 * get() intentionally returns plaintext: future tools must account for provider context,
 * SDK transcripts and later commands containing it. This class cannot redact those uses.
 * Queues serialize instances sharing a normalized root ONLY within this process.
 * Bounded synchronous I/O keeps the enabled check and rename in one JS turn. Atomic
 * replacement is not fsync durability. Path checks are not a hostile-process race lock;
 * the injected directory and its ancestors must remain under trusted OS control.
 */
export class SecretVault {
  private readonly directory: string
  private readonly file: string
  private readonly queueKey: string

  constructor(private readonly options: SecretVaultOptions) {
    if (typeof options.directory !== 'string' || !isAbsolute(options.directory) ||
        options.directory.includes('\0') || typeof options.enabled !== 'function' ||
        !options.secureStorage) throw new SecretVaultError('INVALID_INPUT')
    this.directory = resolve(options.directory)
    this.file = join(this.directory, 'secret-vault.json')
    this.queueKey = process.platform === 'win32' ? this.directory.toLowerCase() : this.directory
  }

  async put(name: string, value: string): Promise<SecretMetadata> {
    this.requireEnabled()
    this.checkName(name)
    if (!validValue(value)) throw new SecretVaultError('INVALID_INPUT')
    this.requireEncryption()
    let ciphertext: string
    try {
      const encrypted = this.options.secureStorage.encryptString(value)
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > MAX_CIPHERTEXT_BYTES) {
        throw new Error()
      }
      ciphertext = encrypted.toString('base64')
    } catch { throw new SecretVaultError('CRYPTO_FAILED') }
    // Only ciphertext enters the queued closure, never a plaintext journal or disk write.
    return this.enqueue(() => {
      this.requireEnabled()
      this.requireEncryption()
      const data = this.load()
      // A syntactically valid but undecryptable old record must never be overwritten.
      for (const record of data.records) this.decrypt(record.ciphertext)
      const previous = data.records.find((record) => record.name === name)
      const now = new Date().toISOString()
      const updatedAt = previous && previous.updatedAt > now ? previous.updatedAt : now
      const metadata = { name, createdAt: previous?.createdAt ?? now, updatedAt }
      data.records = data.records.filter((record) => record.name !== name)
      data.records.push({ ...metadata, ciphertext })
      if (data.records.length > MAX_RECORDS) throw new SecretVaultError('INVALID_INPUT')
      this.persist(data, () => { this.requireEncryption(); this.requireEnabled() })
      this.audit('put', name)
      this.requireEnabled()
      return metadata
    })
  }

  async get(name: string): Promise<string | null> {
    this.requireEnabled()
    this.checkName(name)
    return this.enqueue(() => {
      this.requireEnabled()
      this.requireEncryption()
      const record = this.load().records.find((item) => item.name === name)
      const value = record ? this.decrypt(record.ciphertext) : null
      this.requireEnabled()
      if (record) this.audit('get', name)
      this.requireEncryption()
      this.requireEnabled()
      return value
    })
  }

  /** Management-only: may list names/dates while model access is disabled. */
  async listMetadataForManagement(): Promise<SecretMetadata[]> {
    return this.enqueue(() => this.load().records.map(({ name, createdAt, updatedAt }) =>
      ({ name, createdAt, updatedAt })))
  }

  /** Management-only: call only on an explicit deletion request, never when disabling. */
  async deleteForManagement(name: string): Promise<boolean> {
    this.checkName(name)
    return this.enqueue(() => {
      const data = this.load()
      const records = data.records.filter((record) => record.name !== name)
      if (records.length === data.records.length) return false
      this.persist({ version: 1, records }, () => {})
      this.audit('delete', name)
      return true
    })
  }

  private checkName(name: unknown): void {
    if (!validName(name)) throw new SecretVaultError('INVALID_INPUT')
  }
  private requireEnabled(): void {
    try { if (this.options.enabled() === true) return } catch { /* fail closed */ }
    throw new SecretVaultError('DISABLED')
  }
  private requireEncryption(): void {
    try { if (this.options.secureStorage.isEncryptionAvailable() === true) return } catch { /* fail closed */ }
    throw new SecretVaultError('UNAVAILABLE')
  }
  private decrypt(ciphertext: string): string {
    this.requireEncryption()
    try {
      const value = this.options.secureStorage.decryptString(Buffer.from(ciphertext, 'base64'))
      if (!validValue(value)) throw new Error()
      return value
    } catch { throw new SecretVaultError('CRYPTO_FAILED') }
  }
  private audit(action: 'get' | 'put' | 'delete', name: string): void {
    try { this.options.audit?.({ action, name }) } catch { /* Never expose sink errors or secret causes. */ }
  }
  private enqueue<T>(operation: () => T): Promise<T> {
    const previous = queues.get(this.queueKey) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(() => {
      try { return operation() } catch (error) { throw safeError(error) }
    })
    const settled = result.then(() => {}, () => {})
    queues.set(this.queueKey, settled)
    void settled.then(() => { if (queues.get(this.queueKey) === settled) queues.delete(this.queueKey) })
    return result
  }

  private checkDirectories(create: boolean): boolean {
    const root = parse(this.directory).root
    const parts = this.directory.slice(root.length).split(/[\\/]/).filter(Boolean)
    let current = root
    for (const part of ['', ...parts]) {
      if (part) current = join(current, part)
      let stat: ReturnType<typeof lstatSync>
      try { stat = lstatSync(current) } catch (error) {
        if (!missing(error)) throw error
        if (!create) return false
        mkdirSync(current, { mode: 0o700 })
        stat = lstatSync(current)
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SecretVaultError('UNSAFE_PATH')
    }
    return true
  }

  private targetExists(): boolean {
    try {
      const stat = lstatSync(this.file)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new SecretVaultError('UNSAFE_PATH')
      return true
    } catch (error) { if (missing(error)) return false; throw error }
  }

  private load(): Envelope {
    if (!this.checkDirectories(false) || !this.targetExists()) return { version: 1, records: [] }
    const fd = openSync(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let text: string
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1) throw new SecretVaultError('UNSAFE_PATH')
      if (stat.size > MAX_FILE_BYTES) throw new SecretVaultError('INVALID_DATA')
      text = readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
    try {
      const data = JSON.parse(text) as Envelope
      if (!data || data.version !== 1 || Object.keys(data).sort().join() !== 'records,version' ||
          !Array.isArray(data.records) || data.records.length > MAX_RECORDS) throw new Error()
      const names = new Set<string>()
      for (const record of data.records) {
        if (!record || Object.keys(record).sort().join() !== 'ciphertext,createdAt,name,updatedAt' ||
            !validName(record.name) || names.has(record.name) || !validDate(record.createdAt) ||
            !validDate(record.updatedAt) || record.updatedAt < record.createdAt ||
            typeof record.ciphertext !== 'string' || !record.ciphertext.length ||
            record.ciphertext.length > Math.ceil(MAX_CIPHERTEXT_BYTES / 3) * 4 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.ciphertext) ||
            Buffer.from(record.ciphertext, 'base64').length > MAX_CIPHERTEXT_BYTES ||
            Buffer.from(record.ciphertext, 'base64').toString('base64') !== record.ciphertext) throw new Error()
        names.add(record.name)
      }
      return data
    } catch { throw new SecretVaultError('INVALID_DATA') }
  }

  private persist(data: Envelope, authorize: () => void): void {
    const serialized = JSON.stringify(data)
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new SecretVaultError('INVALID_INPUT')
    authorize()
    this.checkDirectories(true)
    this.targetExists()
    const temporary = join(dirname(this.file), `.secret-vault-${randomUUID()}.tmp`)
    let created = false
    try {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0), 0o600)
      created = true
      try { fs.writeFileSync(fd, serialized, 'utf8') } finally { closeSync(fd) }
      this.checkDirectories(false)
      this.targetExists()
      authorize()
      fs.renameSync(temporary, this.file)
      created = false
    } finally {
      if (created) { try { unlinkSync(temporary) } catch { /* Ciphertext-only orphan; never log paths. */ } }
    }
  }
}
