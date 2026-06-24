import { DEFAULT_CONFIG, type AppConfig } from '../shared/ipc'
import { kvGet, kvSet } from './store'

// App configuration persisted in the cache folder's SQLite db (key "config"),
// see store.ts. Kept in the main process so secrets like the Stitch API key and
// the Android session token never round-trip through the renderer except when the
// user edits them. Legacy settings.json is migrated into the db on first run.

const KEY = 'config'

/** Read the persisted config, merged over defaults (missing keys are filled in). */
export function loadConfig(): AppConfig {
  try {
    const raw = kvGet(KEY)
    if (!raw) return { ...DEFAULT_CONFIG, stitch: { ...DEFAULT_CONFIG.stitch } }
    const parsed = JSON.parse(raw) as Partial<AppConfig>
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      stitch: { ...DEFAULT_CONFIG.stitch, ...(parsed.stitch ?? {}) }
    }
  } catch {
    return { ...DEFAULT_CONFIG, stitch: { ...DEFAULT_CONFIG.stitch } }
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
 * settings (Stitch, "Permitir tudo", the remote token) be saved separately
 * without clobbering each other. Returns the merged config.
 */
export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const cur = loadConfig()
  const next: AppConfig = {
    ...cur,
    ...patch,
    stitch: { ...cur.stitch, ...(patch.stitch ?? {}) }
  }
  saveConfig(next)
  return next
}
