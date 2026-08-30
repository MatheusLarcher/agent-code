import type { KvScope } from './types'

export interface PersistedKeyDefinition {
  scope: KvScope
  sensitive?: boolean
  legacyOnly?: boolean
  source: 'main-kv' | 'renderer-local-storage'
}

export const PERSISTED_KEY_REGISTRY = {
  config: { scope: 'device', sensitive: true, legacyOnly: true, source: 'main-kv' },
  'config.openai.apiKey': { scope: 'device', sensitive: true, source: 'main-kv' },
  'config.openai.voice': { scope: 'device', source: 'main-kv' },
  'config.openai.speed': { scope: 'device', source: 'main-kv' },
  'config.transcribeEngine': { scope: 'device', source: 'main-kv' },
  'config.localSpeech.model': { scope: 'device', source: 'main-kv' },
  'config.ollama.enabled': { scope: 'device', source: 'main-kv' },
  'config.ollama.apiKey': { scope: 'device', sensitive: true, source: 'main-kv' },
  'config.skipPermissions': { scope: 'global', source: 'main-kv' },
  'config.windowsControlEnabled': { scope: 'device', source: 'main-kv' },
  'config.remoteToken': { scope: 'device', sensitive: true, source: 'main-kv' },
  'config.remoteEnabled': { scope: 'device', source: 'main-kv' },
  codexAuth: { scope: 'device', sensitive: true, source: 'main-kv' },
  'memory-curator:last-run-at': { scope: 'device', source: 'main-kv' },
  'agentcode.ui.v1': { scope: 'device', source: 'main-kv' },
  'agentcode.usage-limits.v1': { scope: 'device', source: 'main-kv' },
  'agentcode.pgraph.hidden-types.v1': { scope: 'device', source: 'main-kv' },
  'agentcode.pgraph.hidden-kinds.v1': { scope: 'device', source: 'main-kv' },
  'agentcode.conversations.v1': {
    scope: 'device',
    legacyOnly: true,
    source: 'renderer-local-storage'
  },
  'agentcode.conversations.legacy-checked.v1': {
    scope: 'device',
    legacyOnly: true,
    source: 'renderer-local-storage'
  },
  'agentcode.micId': { scope: 'device', source: 'renderer-local-storage' }
} as const satisfies Record<string, PersistedKeyDefinition>

export type RegisteredPersistedKey = keyof typeof PERSISTED_KEY_REGISTRY

export function isRegisteredPersistedKey(key: string): key is RegisteredPersistedKey {
  return Object.hasOwn(PERSISTED_KEY_REGISTRY, key)
}

export function persistedKeyDefinition(key: string): PersistedKeyDefinition {
  if (!isRegisteredPersistedKey(key)) throw new TypeError(`Chave persistente sem escopo declarado: ${key}`)
  return PERSISTED_KEY_REGISTRY[key]
}

export function migrationScopeForUnknownKey(): KvScope {
  return 'device'
}
