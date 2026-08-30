import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { PostgresConnectionDraft, PostgresPublicSettings, StorageBackend } from '../../shared/ipc'
import { StorageError } from './types'

export const POSTGRES_DATABASE = 'agent-code' as const

const connectionSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535),
  user: z.string().trim().min(1).max(128),
  maintenanceDatabase: z.string().trim().min(1).max(128),
  tlsMode: z.enum(['disable', 'prefer', 'require', 'verify-full']),
  ca: z.string().max(1_000_000),
  encryptedPassword: z.string(),
  targetDatabase: z.literal(POSTGRES_DATABASE)
})

const bootstrapSchema = z.object({
  version: z.literal(1),
  installationId: z.string().uuid(),
  backend: z.enum(['sqlite', 'postgres']),
  transitionState: z.enum(['idle', 'activating-postgres', 'deactivating-postgres']),
  transitionId: z.string().uuid().nullable(),
  lastConfirmedTransitionId: z.string().uuid().nullable(),
  postgres: connectionSchema
})

export type BootstrapData = z.infer<typeof bootstrapSchema>

export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

function defaults(): BootstrapData {
  return {
    version: 1,
    installationId: randomUUID(),
    backend: 'sqlite',
    transitionState: 'idle',
    transitionId: null,
    lastConfirmedTransitionId: null,
    postgres: {
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      maintenanceDatabase: 'postgres',
      tlsMode: 'disable',
      ca: '',
      encryptedPassword: '',
      targetDatabase: POSTGRES_DATABASE
    }
  }
}

export class BootstrapStore {
  private data: BootstrapData | null = null

  constructor(
    userDataDir: string,
    private readonly secureStorage: SecureStorageAdapter
  ) {
    this.path = join(userDataDir, 'storage-bootstrap.json')
  }

  private readonly path: string

  async load(): Promise<BootstrapData> {
    if (this.data) return structuredClone(this.data)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('INVALID_PERSISTED_DATA', 'Bootstrap de persistência inválido.', false, {
          cause: error
        })
      }
      const initial = defaults()
      await this.write(initial)
      return structuredClone(initial)
    }
    const checked = bootstrapSchema.safeParse(parsed)
    if (!checked.success) {
      throw new StorageError('INVALID_PERSISTED_DATA', 'Bootstrap de persistência inválido.', false, {
        cause: checked.error
      })
    }
    this.data = checked.data
    return structuredClone(checked.data)
  }

  async publicSettings(): Promise<PostgresPublicSettings> {
    const value = await this.load()
    return {
      host: value.postgres.host,
      port: value.postgres.port,
      user: value.postgres.user,
      maintenanceDatabase: value.postgres.maintenanceDatabase,
      tlsMode: value.postgres.tlsMode,
      ca: value.postgres.ca,
      targetDatabase: POSTGRES_DATABASE,
      hasPassword: Boolean(value.postgres.encryptedPassword)
    }
  }

  async connection(draft?: PostgresConnectionDraft): Promise<PostgresConnectionDraft> {
    const value = await this.load()
    const password = draft?.password || this.decryptPassword(value.postgres.encryptedPassword)
    return {
      host: draft?.host ?? value.postgres.host,
      port: draft?.port ?? value.postgres.port,
      user: draft?.user ?? value.postgres.user,
      password,
      maintenanceDatabase: draft?.maintenanceDatabase ?? value.postgres.maintenanceDatabase,
      tlsMode: draft?.tlsMode ?? value.postgres.tlsMode,
      ca: draft?.ca ?? value.postgres.ca
    }
  }

  async saveConnection(draft: PostgresConnectionDraft): Promise<void> {
    const current = await this.load()
    const encryptedPassword = draft.password
      ? this.encryptPassword(draft.password)
      : current.postgres.encryptedPassword
    await this.write({
      ...current,
      postgres: {
        host: draft.host.trim(),
        port: draft.port,
        user: draft.user.trim(),
        maintenanceDatabase: draft.maintenanceDatabase.trim(),
        tlsMode: draft.tlsMode,
        ca: draft.ca,
        encryptedPassword,
        targetDatabase: POSTGRES_DATABASE
      }
    })
  }

  async clearPassword(): Promise<void> {
    const current = await this.load()
    await this.write({ ...current, postgres: { ...current.postgres, encryptedPassword: '' } })
  }

  async beginTransition(state: 'activating-postgres' | 'deactivating-postgres'): Promise<string> {
    const current = await this.load()
    if (current.transitionState !== 'idle') {
      throw new StorageError('TRANSITION_IN_PROGRESS', 'Já existe uma transição de storage em andamento.')
    }
    const transitionId = randomUUID()
    await this.write({ ...current, transitionState: state, transitionId })
    return transitionId
  }

  async confirmBackend(backend: StorageBackend, transitionId: string): Promise<void> {
    const current = await this.load()
    if (current.transitionId !== transitionId) {
      throw new StorageError('TRANSITION_IN_PROGRESS', 'A transição de storage não corresponde ao bootstrap.')
    }
    await this.write({
      ...current,
      backend,
      transitionState: 'idle',
      transitionId: null,
      lastConfirmedTransitionId: transitionId
    })
  }

  async abortTransition(transitionId: string): Promise<void> {
    const current = await this.load()
    if (current.transitionId !== transitionId) return
    await this.write({ ...current, transitionState: 'idle', transitionId: null })
  }

  private encryptPassword(password: string): string {
    if (!this.secureStorage.isEncryptionAvailable()) {
      throw new StorageError(
        'SECURE_STORAGE_UNAVAILABLE',
        'O sistema não disponibilizou armazenamento seguro para salvar a senha PostgreSQL.'
      )
    }
    const encrypted = this.secureStorage.encryptString(password)
    if (!encrypted.length) throw new StorageError('SECURE_STORAGE_UNAVAILABLE', 'A senha não pôde ser criptografada.')
    return encrypted.toString('base64')
  }

  private decryptPassword(encrypted: string): string {
    if (!encrypted) return ''
    if (!this.secureStorage.isEncryptionAvailable()) {
      throw new StorageError('SECURE_STORAGE_UNAVAILABLE', 'A senha PostgreSQL salva não pode ser descriptografada.')
    }
    try {
      return this.secureStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch (cause) {
      throw new StorageError('SECURE_STORAGE_UNAVAILABLE', 'A senha PostgreSQL salva não pode ser descriptografada.', false, {
        cause
      })
    }
  }

  private async write(next: BootstrapData): Promise<void> {
    const checked = bootstrapSchema.parse(next)
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp-${process.pid}-${Date.now()}`
    try {
      await writeFile(temp, JSON.stringify(checked, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temp, this.path)
    } catch (cause) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new StorageError('STORAGE_OFFLINE', 'Não foi possível salvar o bootstrap de persistência.', true, {
        cause
      })
    }
    this.data = checked
  }
}
