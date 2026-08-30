import type { KvScope, StorageBackend } from './types'

export type PersistenceSurface =
  | 'bootstrap'
  | 'main-kv'
  | 'conversation-store'
  | 'renderer-local-storage'
  | 'filesystem'
  | 'agent-sdk'
  | 'export'

export interface PersistenceInventoryItem {
  id: string
  owner: string
  surface: PersistenceSurface
  postgresScope: KvScope | 'shared-record' | 'local-only' | 'derived'
  authoritativeInPostgresMode: StorageBackend | 'filesystem' | 'bootstrap'
  keys?: readonly string[]
}

export const PERSISTENCE_INVENTORY: readonly PersistenceInventoryItem[] = [
  {
    id: 'backend-bootstrap',
    owner: 'src/main/persistence/bootstrapStore.ts',
    surface: 'bootstrap',
    postgresScope: 'local-only',
    authoritativeInPostgresMode: 'bootstrap'
  },
  {
    id: 'cache-pointer',
    owner: 'src/main/store.ts',
    surface: 'filesystem',
    postgresScope: 'local-only',
    authoritativeInPostgresMode: 'filesystem'
  },
  {
    id: 'app-config',
    owner: 'src/main/config.ts',
    surface: 'main-kv',
    postgresScope: 'device',
    authoritativeInPostgresMode: 'postgres',
    keys: [
      'config',
      'config.openai.apiKey',
      'config.openai.voice',
      'config.openai.speed',
      'config.transcribeEngine',
      'config.localSpeech.model',
      'config.ollama.enabled',
      'config.ollama.apiKey',
      'config.skipPermissions',
      'config.windowsControlEnabled',
      'config.remoteToken',
      'config.remoteEnabled'
    ]
  },
  {
    id: 'codex-auth',
    owner: 'src/main/codexAuth.ts',
    surface: 'main-kv',
    postgresScope: 'device',
    authoritativeInPostgresMode: 'postgres',
    keys: ['codexAuth']
  },
  {
    id: 'memory-curator-state',
    owner: 'src/main/memoryCurator.ts',
    surface: 'main-kv',
    postgresScope: 'device',
    authoritativeInPostgresMode: 'postgres',
    keys: ['memory-curator:last-run-at']
  },
  {
    id: 'renderer-ui-state',
    owner: 'src/renderer/src/storage.ts',
    surface: 'main-kv',
    postgresScope: 'device',
    authoritativeInPostgresMode: 'postgres',
    keys: ['agentcode.ui.v1', 'agentcode.usage-limits.v1']
  },
  {
    id: 'project-graph-state',
    owner: 'src/renderer/src/components/ProjectGraph.tsx',
    surface: 'main-kv',
    postgresScope: 'device',
    authoritativeInPostgresMode: 'postgres',
    keys: ['agentcode.pgraph.hidden-types.v1', 'agentcode.pgraph.hidden-kinds.v1']
  },
  {
    id: 'rendered-conversations',
    owner: 'src/main/projectStore.ts',
    surface: 'conversation-store',
    postgresScope: 'shared-record',
    authoritativeInPostgresMode: 'postgres'
  },
  {
    id: 'legacy-renderer-state',
    owner: 'src/renderer/src/storage.ts',
    surface: 'renderer-local-storage',
    postgresScope: 'device',
    authoritativeInPostgresMode: 'postgres',
    keys: ['agentcode.conversations.v1', 'agentcode.conversations.legacy-checked.v1']
  },
  {
    id: 'microphone-selection',
    owner: 'src/renderer/src/components/Composer.tsx',
    surface: 'renderer-local-storage',
    postgresScope: 'device',
    authoritativeInPostgresMode: 'postgres',
    keys: ['agentcode.micId']
  },
  {
    id: 'agent-sdk-transcripts',
    owner: '@anthropic-ai/claude-agent-sdk SessionStore',
    surface: 'agent-sdk',
    postgresScope: 'shared-record',
    authoritativeInPostgresMode: 'postgres'
  },
  {
    id: 'agent-task-files',
    owner: 'src/main/sessionTasks.ts',
    surface: 'agent-sdk',
    postgresScope: 'derived',
    authoritativeInPostgresMode: 'filesystem'
  },
  {
    id: 'memory-markdown',
    owner: 'src/main/memoryIndex.ts',
    surface: 'filesystem',
    postgresScope: 'local-only',
    authoritativeInPostgresMode: 'filesystem'
  },
  {
    id: 'cache-skills',
    owner: 'src/main/skillManager.ts',
    surface: 'filesystem',
    postgresScope: 'local-only',
    authoritativeInPostgresMode: 'filesystem'
  },
  {
    id: 'conversation-parquet',
    owner: 'src/main/conversationParquet.ts',
    surface: 'export',
    postgresScope: 'derived',
    authoritativeInPostgresMode: 'postgres'
  }
]
