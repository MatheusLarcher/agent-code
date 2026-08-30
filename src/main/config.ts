import { safeStorage } from 'electron'
import type { AppConfig } from '../shared/ipc'
import { kvGet } from './store'
import { defaultAppConfig, mergeAppConfig, parseStoredAppConfig } from './persistence/configData'
import { readPersistedKv, writePersistedKv } from './persistence/kvFacade'
import { StorageError } from './persistence/types'

type Field = {
  key: string
  sensitive?: boolean
  get(config: AppConfig): unknown
  patch(value: unknown): Partial<AppConfig>
}

const FIELDS: Field[] = [
  { key: 'config.openai.apiKey', sensitive: true, get: (c) => c.openai.apiKey, patch: (v) => ({ openai: { apiKey: v as string } as AppConfig['openai'] }) },
  { key: 'config.openai.voice', get: (c) => c.openai.voice, patch: (v) => ({ openai: { voice: v as string } as AppConfig['openai'] }) },
  { key: 'config.openai.speed', get: (c) => c.openai.speed, patch: (v) => ({ openai: { speed: v as number } as AppConfig['openai'] }) },
  { key: 'config.transcribeEngine', get: (c) => c.transcribeEngine, patch: (v) => ({ transcribeEngine: v as AppConfig['transcribeEngine'] }) },
  { key: 'config.localSpeech.model', get: (c) => c.localSpeech.model, patch: (v) => ({ localSpeech: { model: v as string } }) },
  { key: 'config.ollama.enabled', get: (c) => c.ollama.enabled, patch: (v) => ({ ollama: { enabled: v as boolean } as AppConfig['ollama'] }) },
  { key: 'config.ollama.apiKey', sensitive: true, get: (c) => c.ollama.apiKey, patch: (v) => ({ ollama: { apiKey: v as string } as AppConfig['ollama'] }) },
  { key: 'config.skipPermissions', get: (c) => c.skipPermissions, patch: (v) => ({ skipPermissions: v as boolean }) },
  { key: 'config.windowsControlEnabled', get: (c) => c.windowsControlEnabled, patch: (v) => ({ windowsControlEnabled: v as boolean }) },
  { key: 'config.remoteToken', sensitive: true, get: (c) => c.remoteToken, patch: (v) => ({ remoteToken: v as string }) },
  { key: 'config.remoteEnabled', get: (c) => c.remoteEnabled, patch: (v) => ({ remoteEnabled: v as boolean }) }
]

let initialized = false
let snapshot = defaultAppConfig()
let writeQueue: Promise<unknown> = Promise.resolve()

function cloneConfig(config: AppConfig): AppConfig {
  return { ...config, openai: { ...config.openai }, localSpeech: { ...config.localSpeech }, ollama: { ...config.ollama } }
}

function loadLegacyConfig(): AppConfig {
  try { return parseStoredAppConfig(kvGet('config')) } catch { return defaultAppConfig() }
}

function encode(value: unknown, sensitive = false): string {
  const json = JSON.stringify(value)
  if (!sensitive || value === '') return json
  if (!safeStorage.isEncryptionAvailable()) {
    throw new StorageError('SECURE_STORAGE_UNAVAILABLE', 'A proteção de segredos do sistema não está disponível.')
  }
  return JSON.stringify({ safeStorage: safeStorage.encryptString(json).toString('base64') })
}

function decode(raw: string, sensitive = false): unknown {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!sensitive || typeof parsed !== 'object' || parsed === null || !('safeStorage' in parsed)) return parsed
    const ciphertext = (parsed as { safeStorage?: unknown }).safeStorage
    if (typeof ciphertext !== 'string') throw new Error('ciphertext inválido')
    return JSON.parse(safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))) as unknown
  } catch (cause) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'Campo de configuração persistido inválido.', false, { cause })
  }
}

async function writeFields(config: AppConfig, only?: Set<string>): Promise<void> {
  for (const field of FIELDS) {
    if (only && !only.has(field.key)) continue
    await writePersistedKv(field.key, encode(field.get(config), field.sensitive))
  }
}

export async function initializeConfigPersistence(): Promise<AppConfig> {
  const legacyRaw = await readPersistedKv('config')
  let next = parseStoredAppConfig(legacyRaw)
  const missing = new Set<string>()
  for (const field of FIELDS) {
    const raw = await readPersistedKv(field.key)
    if (raw === null) {
      missing.add(field.key)
      continue
    }
    next = mergeAppConfig(next, field.patch(decode(raw, field.sensitive)))
  }
  if (missing.size) await writeFields(next, missing)
  snapshot = next
  initialized = true
  return cloneConfig(snapshot)
}

export function loadConfig(): AppConfig {
  return cloneConfig(initialized ? snapshot : loadLegacyConfig())
}

export function saveConfig(config: AppConfig): Promise<void> {
  return enqueueConfigWrite(async () => {
    const next = mergeAppConfig(defaultAppConfig(), config)
    await writeFields(next)
    snapshot = next
  })
}

export function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  return enqueueConfigWrite(async () => {
    const next = mergeAppConfig(snapshot, patch)
    const touched = new Set<string>()
    for (const field of FIELDS) {
      if (JSON.stringify(field.get(snapshot)) !== JSON.stringify(field.get(next))) touched.add(field.key)
    }
    await writeFields(next, touched)
    snapshot = next
    return cloneConfig(next)
  })
}

function enqueueConfigWrite<T>(write: () => Promise<T>): Promise<T> {
  const pending = writeQueue.then(write, write)
  writeQueue = pending.catch(() => undefined)
  return pending
}
