import type { KvScope } from './types'

export interface PersistedKeyDefinition {
  scope: KvScope
  sensitive?: boolean
  legacyOnly?: boolean
  source: 'main-kv' | 'renderer-local-storage'
  /** 'local': no SQLite pequeno desta máquina (localKvStore.ts), lido antes e sem
   *  o banco de dados — configuração, contas Claude e estado da tela. Sem o
   *  atributo, vai para o backend autoritativo (PostgreSQL ou SQLite de dados). */
  store?: 'local'
}

export const PERSISTED_KEY_REGISTRY = {
  config: { scope: 'device', sensitive: true, legacyOnly: true, source: 'main-kv', store: 'local' },
  'config.voice.voice': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.voice.speed': { scope: 'device', source: 'main-kv', store: 'local' },
  // Por máquina: GPU e espaço em disco variam entre os PCs do mesmo usuário.
  'config.voice.whisperModel': { scope: 'device', source: 'main-kv', store: 'local' },
  // Legado da voz via OpenAI: só lido uma vez para migrar a velocidade.
  'config.openai.speed': { scope: 'device', legacyOnly: true, source: 'main-kv', store: 'local' },
  'config.transcribeEngine': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.localSpeech.model': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.ollama.enabled': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.ollama.apiKey': { scope: 'device', sensitive: true, source: 'main-kv', store: 'local' },
  'config.skipPermissions': { scope: 'global', source: 'main-kv', store: 'local' },
  'config.windowsControlEnabled': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.chromeControlEnabled': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.chromeBridgeToken': { scope: 'device', sensitive: true, source: 'main-kv', store: 'local' },
  'config.secretVaultEnabled': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.remoteToken': { scope: 'device', sensitive: true, source: 'main-kv', store: 'local' },
  'config.remoteEnabled': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.preventSleepWhileBusy': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.vigia.enabled': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.vigia.model': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.memorista.enabled': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.memorista.model': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.board.requirePlan': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.board.po.enabled': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.board.po.model': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.planning.model': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.planning.effort': { scope: 'device', source: 'main-kv', store: 'local' },
  // Marcador one-shot: o esforço do Manager já está no formato em que o
  // Automático do esforço é independente do do modelo (ver src/main/config.ts).
  'config.planning.effortSplit': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.typesafe.enabled': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.typesafe.apiKey': { scope: 'device', sensitive: true, source: 'main-kv', store: 'local' },
  'config.typesafe.minConfidence': { scope: 'device', source: 'main-kv', store: 'local' },
  'config.typesafe.allowedAutoModels': { scope: 'device', source: 'main-kv', store: 'local' },
  'agentcode.typesafe.usage.v1': { scope: 'device', source: 'main-kv' },
  codexAuth: { scope: 'device', sensitive: true, source: 'main-kv' },
  // Contas Claude: id, apelido, e-mail, plano e última leitura de consumo. Sem
  // token — a credencial fica na pasta local de cada conta.
  'agentcode.claude-accounts.v1': { scope: 'device', source: 'main-kv', store: 'local' },
  // Cópia da credencial de cada conta extra, CIFRADA pelo safeStorage do sistema
  // (DPAPI no Windows), para recriar a pasta da conta se ela sumir. Ver
  // accounts/accountBackup.ts. Nunca em texto puro.
  'agentcode.claude-account-credentials.v1': { scope: 'device', sensitive: true, source: 'main-kv', store: 'local' },
  // Cópia do cofre (chave + segredos cifrados) no banco. Redundância proposital:
  // migrar só o banco tem de reabrir tudo. Ver vaultMirror.ts.
  'agentcode.secret-vault-mirror.v1': { scope: 'device', sensitive: true, source: 'main-kv' },
  'memory-curator:last-run-at': { scope: 'device', source: 'main-kv' },
  // Autorização do PO para commit/push, por conversa (po/poAuthorization.ts).
  // Global: viaja com a conversa, como ela, no banco dividido entre PCs.
  'agentcode.po-authorizations.v1': { scope: 'global', source: 'main-kv' },
  'agentcode.ui.v1': { scope: 'device', source: 'main-kv', store: 'local' },
  'agentcode.usage-limits.v1': { scope: 'device', source: 'main-kv', store: 'local' },
  'agentcode.pgraph.hidden-types.v1': { scope: 'device', source: 'main-kv', store: 'local' },
  'agentcode.pgraph.hidden-kinds.v1': { scope: 'device', source: 'main-kv', store: 'local' },
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
  'agentcode.micId': { scope: 'device', source: 'renderer-local-storage', store: 'local' }
} as const satisfies Record<string, PersistedKeyDefinition>

export type RegisteredPersistedKey = keyof typeof PERSISTED_KEY_REGISTRY

export function isRegisteredPersistedKey(key: string): key is RegisteredPersistedKey {
  return Object.hasOwn(PERSISTED_KEY_REGISTRY, key)
}

/** Chave que mora no SQLite local desta máquina (`store: 'local'`). */
export function isLocalPersistedKey(key: string): boolean {
  return isRegisteredPersistedKey(key) && (PERSISTED_KEY_REGISTRY[key] as PersistedKeyDefinition).store === 'local'
}

/** Todas as chaves do SQLite local, para a cópia única do banco na atualização. */
export function localPersistedKeys(): RegisteredPersistedKey[] {
  return (Object.keys(PERSISTED_KEY_REGISTRY) as RegisteredPersistedKey[]).filter(isLocalPersistedKey)
}

export function persistedKeyDefinition(key: string): PersistedKeyDefinition {
  if (!isRegisteredPersistedKey(key)) throw new TypeError(`Chave persistente sem escopo declarado: ${key}`)
  return PERSISTED_KEY_REGISTRY[key]
}

export function migrationScopeForUnknownKey(): KvScope {
  return 'device'
}
