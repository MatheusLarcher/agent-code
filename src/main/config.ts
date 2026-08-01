import { DEFAULT_CONFIG, type AppConfig } from '../shared/ipc'
import { kvGet, kvSet } from './store'

// App configuration persisted in the cache folder's SQLite db (key "config"),
// see store.ts. Kept in the main process so secrets like the OpenAI/Ollama API
// keys and the Android session token never round-trip through the renderer except
// when the user edits them. Legacy settings.json is migrated into the db on first run.

const KEY = 'config'

/** Read the persisted config, merged over defaults (missing keys are filled in). */
export function loadConfig(): AppConfig {
  const fresh = (): AppConfig => ({
    ...DEFAULT_CONFIG,
    openai: { ...DEFAULT_CONFIG.openai },
    ollama: { ...DEFAULT_CONFIG.ollama }
  })
  try {
    const raw = kvGet(KEY)
    if (!raw) return fresh()
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      openai: { ...DEFAULT_CONFIG.openai, ...(parsed.openai ?? {}) },
      ollama: { ...DEFAULT_CONFIG.ollama, ...(parsed.ollama ?? {}) }
    }
  } catch {
    return fresh()
  }
}

/** Persist the config to the db (best-effort). */
export function saveConfig(cfg: AppConfig): void {
  try {
    kvSet(KEY, JSON.stringify(cfg))
  } catch {
    /* db error — settings are best-effort */
  }
}

/**
 * Merge a partial config into what's stored and persist it. Lets independent
 * settings (OpenAI, "Permitir tudo", the remote token) be saved separately
 * without clobbering each other. Returns the merged config.
 */
export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const cur = loadConfig()
  const next: AppConfig = {
    ...cur,
    ...patch,
    openai: { ...cur.openai, ...(patch.openai ?? {}) },
    ollama: { ...cur.ollama, ...(patch.ollama ?? {}) }
  }
  saveConfig(next)
  return next
}
