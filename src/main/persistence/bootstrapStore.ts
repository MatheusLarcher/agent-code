import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { PostgresConnectionDraft, PostgresPublicSettings, StorageBackend } from '../../shared/ipc'
import { StorageError } from './types'

export const POSTGRES_DATABASE = 'agent-code' as const
/** Porta preferida do PostgreSQL embutido: fora da 5432 (pode ser de outro
 *  Postgres do usuário) e abaixo da faixa dinâmica do Windows (49152+), onde o
 *  WinNAT/Hyper-V reserva blocos inteiros. Ocupada, o app escolhe outra e grava. */
export const LOCAL_POSTGRES_PORT = 45432

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

const legacyBootstrapSchema = z.object({
  version: z.literal(1),
  installationId: z.string().uuid(),
  backend: z.enum(['sqlite', 'postgres']),
  transitionState: z.enum(['idle', 'activating-postgres', 'deactivating-postgres']),
  transitionId: z.string().uuid().nullable(),
  lastConfirmedTransitionId: z.string().uuid().nullable(),
  postgres: connectionSchema
})

const bootstrapSchema = legacyBootstrapSchema.extend({
  version: z.literal(2),
  /** Qual PostgreSQL vale quando `backend` é postgres: o embutido desta máquina
   *  ou o da nuvem (a conexão em `postgres`, que o usuário configurou). */
  postgresTarget: z.enum(['local', 'cloud']),
  /** O SQLite de dados ainda vai ser importado para o PostgreSQL local (instalação
   *  nova ou atualização de quem estava no SQLite). Some quando um backend é confirmado. */
  pendingLocalImport: z.boolean(),
  /** O servidor embutido: porta e senha do usuário `agentcode` (cifrada). */
  local: z.object({
    port: z.number().int().min(1).max(65_535),
    encryptedPassword: z.string()
  })
})

export type BootstrapData = z.infer<typeof bootstrapSchema>
export type PostgresTarget = BootstrapData['postgresTarget']

/**
 * v1 → v2, sem ninguém mudar de banco sem pedir: quem estava no PostgreSQL (o da
 * nuvem — era o único) continua nele, com a nuvem ligada; quem estava no SQLite
 * importa para o PostgreSQL local na abertura. Uma ativação da nuvem interrompida
 * no meio continua apontando para a nuvem, para a recuperação conferir lá.
 */
function upgradeLegacy(legacy: z.infer<typeof legacyBootstrapSchema>): BootstrapData {
  const cloud = legacy.backend === 'postgres' || legacy.transitionState === 'activating-postgres'
  return {
    ...legacy,
    version: 2,
    postgresTarget: cloud ? 'cloud' : 'local',
    pendingLocalImport: legacy.backend === 'sqlite',
    local: { port: LOCAL_POSTGRES_PORT, encryptedPassword: '' }
  }
}

export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** Instalação nova: começa no PostgreSQL local. Passa pela importação do SQLite
 *  porque uma instalação antiga demais para ter este arquivo também cai aqui —
 *  para quem é nova de verdade, a importação é vazia. */
function defaults(): BootstrapData {
  return {
    version: 2,
    installationId: randomUUID(),
    backend: 'sqlite',
    postgresTarget: 'local',
    pendingLocalImport: true,
    local: { port: LOCAL_POSTGRES_PORT, encryptedPassword: '' },
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
    const legacy = legacyBootstrapSchema.safeParse(parsed)
    if (legacy.success) {
      const upgraded = upgradeLegacy(legacy.data)
      await this.write(upgraded)
      return structuredClone(upgraded)
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

  /** Senha do usuário `agentcode` do PostgreSQL embutido; '' antes do initdb. */
  async localPassword(): Promise<string> {
    return this.decryptPassword((await this.load()).local.encryptedPassword)
  }

  async saveLocalPassword(password: string): Promise<void> {
    const current = await this.load()
    await this.write({ ...current, local: { ...current.local, encryptedPassword: this.encryptPassword(password) } })
  }

  async saveLocalPort(port: number): Promise<void> {
    const current = await this.load()
    await this.write({ ...current, local: { ...current.local, port } })
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
      hasPassword: Boolean(value.postgres.encryptedPassword),
      postgresTarget: value.backend === 'postgres' ? value.postgresTarget : 'local'
    }
  }

  /** A troca local ↔ nuvem confirmada (backup/storageSwitch.ts), numa gravação só:
   *  antes dela vale o lado antigo, intacto; depois, o novo, com a cópia conferida. */
  async selectPostgresTarget(target: PostgresTarget): Promise<void> {
    const current = await this.load()
    if (current.transitionState !== 'idle') {
      throw new StorageError('TRANSITION_IN_PROGRESS', 'Já existe uma transição de storage em andamento.')
    }
    await this.write({ ...current, backend: 'postgres', postgresTarget: target, pendingLocalImport: false })
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

  /** A ativação grava antes para onde vai (`target`): uma queda no meio é
   *  recuperada conferindo esse mesmo PostgreSQL. */
  async beginTransition(
    state: 'activating-postgres' | 'deactivating-postgres',
    target: PostgresTarget = 'cloud'
  ): Promise<string> {
    const current = await this.load()
    if (current.transitionState !== 'idle') {
      throw new StorageError('TRANSITION_IN_PROGRESS', 'Já existe uma transição de storage em andamento.')
    }
    const transitionId = randomUUID()
    await this.write({
      ...current,
      transitionState: state,
      transitionId,
      ...(state === 'activating-postgres' ? { postgresTarget: target } : {})
    })
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
      // Backend confirmado é escolha feita: não sobra importação automática.
      pendingLocalImport: false,
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
