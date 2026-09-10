import { loadConfig } from '../config'
import { getCacheInfo } from '../store'
import type { MemoryRepository } from '../persistence/types'
import { MemoryService } from './memoryService'
import { SecretVault, type SecretMetadata } from './secretVault'
import { createDatabaseSecureStorage } from './vaultKey'
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
  /** Só os testes injetam; em produção a chave vem do banco do Agent Code. */
  secureStorage?: { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
}

/** Live read of the user's switch. Checked per operation, never cached. */
export function secretVaultEnabled(): boolean {
  return loadConfig().secretVaultEnabled === true
}

/**
 * Called once at startup, before any session can ask for a secret.
 *
 * A criptografia usa uma chave do PRÓPRIO banco do Agent Code
 * (`createDatabaseSecureStorage`), não o `safeStorage` do sistema. `loadVaultKey`
 * precisa ter rodado antes: o cofre cifra de forma síncrona e o banco é assíncrono.
 */
export function configureSecretVault(deps: SecretVaultDeps | null): void {
  secureStorage = deps?.secureStorage ?? createDatabaseSecureStorage()
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
  if (service) adoptExistingMemories(service)
}

/**
 * Adopts .md files that exist on disk but not in the database.
 *
 * Sem isto, um acervo já existente fica invisível ao banco até um agente por
 * acaso chamar memory_propose — a única outra porta que chega ao reconcile. Era
 * o caso de um usuário real com 162 memórias: os arquivos estavam lá, o banco
 * vazio, e MEMORY.md sem dono definido. Vale para toda máquina nova e para toda
 * troca de backend, não só para a primeira instalação.
 *
 * Deliberadamente não bloqueia o boot e nunca o derruba: importar memória é
 * recuperável na próxima passada, abrir o app não. `reconcile` é idempotente
 * (a 2ª passada importa 0) e serializado dentro do serviço, então rodar aqui não
 * corre com um propose que chegue em seguida.
 */
function adoptExistingMemories(current: MemoryService): void {
  void current
    .reconcile()
    .then((summary) => {
      if (summary.imported) console.log(`[memory] ${summary.imported} memória(s) adotada(s) do disco`)
      for (const conflict of summary.conflicts) {
        console.warn(`[memory] ${conflict.relPath}: ${conflict.reason}`)
      }
    })
    .catch((error) => {
      // Só registra: o acervo em disco continua intacto e a próxima chamada tenta de novo.
      console.error(`[memory] adoção do acervo falhou: ${error instanceof Error ? error.message : String(error)}`)
    })
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

/**
 * Todas as senhas em texto puro, para irem no prompt — SÓ com o interruptor
 * ligado. É o pedido explícito do usuário: o modelo precisa da senha real para
 * usá-la, e um interruptor desligado é o que garante que ela não sai do disco.
 *
 * Devolve lista vazia (nunca lança) quando desligado, sem cofre ou se a leitura
 * falhar: uma senha ausente degrada o turno, mas não pode impedir o envio.
 */
export async function readSecretsForPrompt(): Promise<Array<{ name: string; value: string }>> {
  const instance = activeVault()
  if (!instance || !secretVaultEnabled()) return []
  try {
    const out: Array<{ name: string; value: string }> = []
    for (const item of await instance.listMetadataForManagement()) {
      const value = await instance.get(item.name)
      if (value !== null) out.push({ name: item.name, value })
    }
    return out
  } catch {
    return []
  }
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
