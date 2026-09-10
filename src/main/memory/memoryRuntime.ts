import { loadConfig } from '../config'
import { getCacheInfo } from '../store'
import type { MemoryRepository } from '../persistence/types'
import { MemoryService } from './memoryService'
import { SecretVault, type SecretMetadata } from './secretVault'
import type { SecretSink } from './memorySecrets'

/**
 * Process-wide handles for the memory service and the secret vault, following
 * the same shape as `kvFacade`: the lifecycle publishes the active repository
 * here on every backend transition, so a session never keeps writing through a
 * repository that was replaced or went offline.
 *
 * The vault is deliberately NOT rebound by backend transitions: it is a
 * device-local encrypted file, outside the KV that syncs to PostgreSQL.
 */
let service: MemoryService | null = null
let vault: SecretVault | null = null
let memoriesDir: string | null = null
let secureStorage: SecretVaultDeps['secureStorage'] | null = null
let vaultDir: string | null = null

export interface SecretVaultDeps {
  /** Absolute, device-local directory. Never the cache folder the user can move. */
  directory: string
  secureStorage: { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
}

/** Live read of the user's switch. Checked per operation, never cached. */
export function secretVaultEnabled(): boolean {
  return loadConfig().secretVaultEnabled === true
}

/** Called once at startup, before any session can ask for a secret. */
export function configureSecretVault(deps: SecretVaultDeps | null): void {
  secureStorage = deps?.secureStorage ?? null
  vaultDir = deps?.directory ?? null
  vault = null
}

/**
 * Called by the storage lifecycle on every bind/offline transition. The folder
 * is read here (not injected) because changing it restarts the app anyway.
 */
export function configureMemoryRuntime(repository: MemoryRepository | null, dir?: string): void {
  memoriesDir = dir ?? (repository ? getCacheInfo().memoriesDir : memoriesDir)
  service = repository && memoriesDir ? new MemoryService(repository, memoriesDir) : null
}

export function memoryService(): MemoryService | null {
  return service
}

export function memoryRoot(): string | null {
  return memoriesDir
}

/**
 * Built lazily so a device without OS encryption only fails when the vault is
 * actually used, instead of blocking startup.
 */
function activeVault(): SecretVault | null {
  if (!vaultDir || !secureStorage) return null
  if (!vault) vault = new SecretVault({ directory: vaultDir, enabled: secretVaultEnabled, secureStorage })
  return vault
}

/** The narrow slice `sanitizeProposal` needs. Null when unavailable on this device. */
export function secretSink(): SecretSink | null {
  const instance = activeVault()
  if (!instance) return null
  return {
    enabled: secretVaultEnabled,
    put: (name, value) => instance.put(name, value)
  }
}

/**
 * Returns the ACTUAL plaintext to an authorized caller — the model needs the
 * real value to use the credential. Encryption protects storage at rest; it
 * cannot unsay a value already sent to a provider's context.
 */
export async function readSecret(name: string): Promise<string | null> {
  const instance = activeVault()
  if (!instance || !secretVaultEnabled()) return null
  return instance.get(name)
}

/** Names and dates only — never a value. For the settings screen. */
export async function listSecretMetadata(): Promise<SecretMetadata[]> {
  const instance = activeVault()
  return instance ? instance.listMetadataForManagement() : []
}

/** Explicit user action in the settings screen; never called when disabling. */
export async function deleteSecret(name: string): Promise<boolean> {
  const instance = activeVault()
  return instance ? instance.deleteForManagement(name) : false
}
