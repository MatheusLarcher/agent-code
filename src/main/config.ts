import { safeStorage } from 'electron'
import type { AppConfig } from '../shared/ipc'
import { kvGet } from './store'
import {
  defaultAppConfig,
  mergeAppConfig,
  normalizeAllowedAutoModels,
  parseStoredAppConfig
} from './persistence/configData'
import { hasConfiguredKvRepository, readPersistedKvMany, writePersistedKv } from './persistence/kvFacade'
import { migratePlanningEffort } from '../shared/autoEffort'
import { StorageError } from './persistence/types'

type Field = {
  key: string
  sensitive?: boolean
  get(config: AppConfig): unknown
  patch(value: unknown): Partial<AppConfig>
}

const FIELDS: Field[] = [
  { key: 'config.voice.voice', get: (c) => c.voice.voice, patch: (v) => ({ voice: { voice: v } as AppConfig['voice'] }) },
  { key: 'config.voice.speed', get: (c) => c.voice.speed, patch: (v) => ({ voice: { speed: v as number } as AppConfig['voice'] }) },
  // Ausente (config de antes do seletor) = sem escolha explícita: o boot grava o padrão (turbo-q8).
  { key: 'config.voice.whisperModel', get: (c) => c.voice.whisperModel, patch: (v) => ({ voice: { whisperModel: v } as AppConfig['voice'] }) },
  { key: 'config.transcribeEngine', get: (c) => c.transcribeEngine, patch: (v) => ({ transcribeEngine: v as AppConfig['transcribeEngine'] }) },
  { key: 'config.localSpeech.model', get: (c) => c.localSpeech.model, patch: (v) => ({ localSpeech: { model: v as string } }) },
  { key: 'config.ollama.enabled', get: (c) => c.ollama.enabled, patch: (v) => ({ ollama: { enabled: v as boolean } as AppConfig['ollama'] }) },
  { key: 'config.ollama.apiKey', sensitive: true, get: (c) => c.ollama.apiKey, patch: (v) => ({ ollama: { apiKey: v as string } as AppConfig['ollama'] }) },
  { key: 'config.skipPermissions', get: (c) => c.skipPermissions, patch: (v) => ({ skipPermissions: v as boolean }) },
  { key: 'config.windowsControlEnabled', get: (c) => c.windowsControlEnabled, patch: (v) => ({ windowsControlEnabled: v as boolean }) },
  { key: 'config.chromeControlEnabled', get: (c) => c.chromeControlEnabled, patch: (v) => ({ chromeControlEnabled: v as boolean }) },
  { key: 'config.chromeBridgeToken', sensitive: true, get: (c) => c.chromeBridgeToken, patch: (v) => ({ chromeBridgeToken: v as string }) },
  { key: 'config.secretVaultEnabled', get: (c) => c.secretVaultEnabled, patch: (v) => ({ secretVaultEnabled: v as boolean }) },
  { key: 'config.remoteToken', sensitive: true, get: (c) => c.remoteToken, patch: (v) => ({ remoteToken: v as string }) },
  { key: 'config.remoteEnabled', get: (c) => c.remoteEnabled, patch: (v) => ({ remoteEnabled: v as boolean }) },
  { key: 'config.preventSleepWhileBusy', get: (c) => c.preventSleepWhileBusy, patch: (v) => ({ preventSleepWhileBusy: v as boolean }) },
  { key: 'config.vigia.enabled', get: (c) => c.vigia.enabled, patch: (v) => ({ vigia: { enabled: v as boolean } as AppConfig['vigia'] }) },
  { key: 'config.vigia.model', get: (c) => c.vigia.model, patch: (v) => ({ vigia: { model: v as string } as AppConfig['vigia'] }) },
  { key: 'config.memorista.enabled', get: (c) => c.memorista.enabled, patch: (v) => ({ memorista: { enabled: v as boolean } as AppConfig['memorista'] }) },
  { key: 'config.memorista.model', get: (c) => c.memorista.model, patch: (v) => ({ memorista: { model: v as string } as AppConfig['memorista'] }) },
  { key: 'config.board.requirePlan', get: (c) => c.board.requirePlan, patch: (v) => ({ board: { requirePlan: v as boolean } as AppConfig['board'] }) },
  { key: 'config.board.po.enabled', get: (c) => c.board.po.enabled, patch: (v) => ({ board: { po: { enabled: v as boolean } } as AppConfig['board'] }) },
  { key: 'config.board.po.model', get: (c) => c.board.po.model, patch: (v) => ({ board: { po: { model: v as string } } as AppConfig['board'] }) },
  { key: 'config.planning.model', get: (c) => c.planning.model, patch: (v) => ({ planning: { model: v as string } as AppConfig['planning'] }) },
  { key: 'config.planning.effort', get: (c) => c.planning.effort, patch: (v) => ({ planning: { effort: v as AppConfig['planning']['effort'] } as AppConfig['planning'] }) },
  { key: 'config.typesafe.enabled', get: (c) => c.typesafe.enabled, patch: (v) => ({ typesafe: { enabled: v as boolean } as AppConfig['typesafe'] }) },
  { key: 'config.typesafe.apiKey', sensitive: true, get: (c) => c.typesafe.apiKey, patch: (v) => ({ typesafe: { apiKey: v as string } as AppConfig['typesafe'] }) },
  { key: 'config.typesafe.minConfidence', get: (c) => c.typesafe.minConfidence, patch: (v) => ({ typesafe: { minConfidence: v as number } as AppConfig['typesafe'] }) },
  // Lista (não escalar): vai como JSON de array pelo mesmo encode. Valor lido que
  // não é lista de textos volta ao padrão [] em vez de derrubar o boot.
  { key: 'config.typesafe.allowedAutoModels', get: (c) => c.typesafe.allowedAutoModels, patch: (v) => ({ typesafe: { allowedAutoModels: normalizeAllowedAutoModels(v) } as AppConfig['typesafe'] }) }
]

/** Every KV key the config persists, in write order. Exported so a test can hold
 *  it against `PERSISTED_KEY_REGISTRY`: a field added here without a matching
 *  registry entry makes `persistedKeyDefinition` throw inside
 *  `initializeConfigPersistence` — which runs BEFORE the window is created, so the
 *  app boots into an invisible, hung process. */
export const CONFIG_PERSISTED_KEYS: readonly string[] = FIELDS.map((field) => field.key)

/**
 * Marcador one-shot da separação dos Automáticos no config do Agent Manager.
 * Antes dela, `planning.model:'auto'` decidia o esforço também, e o esforço
 * gravado era ignorado; ausente o marcador, o boot converte esse par para
 * `effort:'auto'` UMA vez e grava o marcador — senão um "Automático + Alto"
 * escolhido depois voltaria a `auto` a cada abertura do app.
 */
export const PLANNING_EFFORT_SPLIT_KEY = 'config.planning.effortSplit'

/**
 * Velocidade de leitura gravada no tempo da voz via OpenAI (removida). Só é
 * lida para migrar para `config.voice.speed` quando esta ainda não existe. A
 * chave da OpenAI (`config.openai.apiKey`) e a voz antiga não são mais lidas:
 * ficam ignoradas no banco, sem erro.
 */
export const LEGACY_VOICE_SPEED_KEY = 'config.openai.speed'
let initialized = false
let snapshot = defaultAppConfig()
let writeQueue: Promise<unknown> = Promise.resolve()
// Dedupe concorrência de boot: `configGet`/`typesafe:is-configured` podem
// chegar do renderer assim que `waitForStorageReady()` resolve — ANTES de o
// próprio boot chamar `initializeConfigPersistence()`. Sem isto, essa corrida
// fazia `loadConfig()` cair no fallback `loadLegacyConfig()` (o KV local
// antigo) e responder "TypeSafe desativado" / "sem key de voz" mesmo com as
// duas já configuradas — só sumia depois de algo chamar `getConfig()` de novo.
let initPromise: Promise<AppConfig> | null = null

function cloneConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    voice: { ...config.voice },
    localSpeech: { ...config.localSpeech },
    ollama: { ...config.ollama },
    vigia: { ...config.vigia },
    memorista: { ...config.memorista },
    planning: { ...config.planning },
    board: { ...config.board, po: { ...config.board.po } },
    typesafe: { ...config.typesafe, allowedAutoModels: [...config.typesafe.allowedAutoModels] }
  }
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

/** Lê o banco e troca o snapshot. Só roda DENTRO da `writeQueue`: assim uma
 *  leitura antiga nunca sobrescreve o que uma escrita gravou no meio dela. */
async function readConfig(): Promise<AppConfig> {
  // Uma leitura por escopo, não uma por campo: isto roda no caminho de
  // abertura do app e, com PostgreSQL remoto, cada campo custava uma ida
  // e volta à rede.
  const stored = await readPersistedKvMany([
    'config',
    ...CONFIG_PERSISTED_KEYS,
    PLANNING_EFFORT_SPLIT_KEY,
    LEGACY_VOICE_SPEED_KEY
  ])
  let next = parseStoredAppConfig(stored.get('config') ?? null)
  const missing = new Set<string>()
  for (const field of FIELDS) {
    const raw = stored.get(field.key) ?? null
    if (raw === null) {
      missing.add(field.key)
      continue
    }
    next = mergeAppConfig(next, field.patch(decode(raw, field.sensitive)))
  }
  if (missing.has('config.voice.speed')) next = migrateLegacySpeed(next, stored.get(LEGACY_VOICE_SPEED_KEY) ?? null)
  const splitPending = (stored.get(PLANNING_EFFORT_SPLIT_KEY) ?? null) === null
  if (splitPending) {
    const planning = migratePlanningEffort(next.planning)
    if (planning !== next.planning) {
      next = { ...next, planning }
      missing.add('config.planning.effort')
    }
  }
  if (missing.size) await writeFields(next, missing)
  // Depois do esforço: se o processo cair entre as duas escritas, a
  // migração roda de novo no próximo boot — e ela é idempotente.
  if (splitPending) await writePersistedKv(PLANNING_EFFORT_SPLIT_KEY, 'true')
  snapshot = next
  initialized = true
  return cloneConfig(snapshot)
}

/** Leva a velocidade antiga para `voice.speed`. Valor ilegível é ignorado: a
 *  migração nunca derruba o boot. */
function migrateLegacySpeed(config: AppConfig, raw: string | null): AppConfig {
  if (raw === null) return config
  try {
    const speed = decode(raw)
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) return config
    return mergeAppConfig(config, { voice: { speed } })
  } catch {
    return config
  }
}

/** Dentro da fila: garante o snapshot do banco antes de uma escrita. Não usa
 *  `ensureConfigLoaded` (que entra na fila) para não travar esperando a si mesma. */
async function loadInQueue(): Promise<void> {
  if (!initialized) await readConfig()
}

export function initializeConfigPersistence(): Promise<AppConfig> {
  if (!initPromise) {
    const attempt = enqueueConfigWrite(async () => (initialized ? cloneConfig(snapshot) : readConfig()))
    initPromise = attempt
    // Falha não fica guardada: com o banco offline no boot, a promise rejeitada
    // cacheada fazia todo `configGet` falhar até reiniciar o app, mesmo depois
    // de o banco voltar.
    attempt.catch(() => {
      if (initPromise === attempt) initPromise = null
    })
  }
  return initPromise
}

/** Relê o banco mesmo com a config já carregada (change feed, troca da pasta
 *  de dados). Passa pela fila: serializa com as escritas. */
export function reloadConfigPersistence(): Promise<AppConfig> {
  return enqueueConfigWrite(readConfig)
}

/** Espera a config persistida carregar, se ainda não carregou. Quem precisa
 *  de uma resposta correta (não do fallback local) antes do boot terminar de
 *  ler o banco autoritativo chama isto antes de `loadConfig()`. */
export async function ensureConfigLoaded(): Promise<void> {
  if (initialized) return
  await initializeConfigPersistence()
}

export function isConfigLoaded(): boolean {
  return initialized
}

export function loadConfig(): AppConfig {
  if (initialized) return cloneConfig(snapshot)
  // Com backend gerenciado (PostgreSQL, mesmo offline), o SQLite legado é um
  // blob antigo: respondia TypeSafe/Windows/Chrome desligados e sem key como
  // se fosse a config real. O legado só vale quando não há backend nenhum.
  return hasConfiguredKvRepository() ? defaultAppConfig() : cloneConfig(loadLegacyConfig())
}

export function saveConfig(config: AppConfig): Promise<void> {
  return enqueueConfigWrite(async () => {
    await loadInQueue()
    const next = mergeAppConfig(defaultAppConfig(), config)
    await writeFields(next)
    snapshot = next
  })
}

export function updateConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  return enqueueConfigWrite(async () => {
    // Nunca compara com o snapshot padrão: um campo "diferente do padrão"
    // seria gravado por cima do valor real (ex.: apiKey vazia). Se a carga
    // falha, a escrita falha junto.
    await loadInQueue()
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
