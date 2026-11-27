// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserController } from './browserController'
const sdk = vi.hoisted(() => ({ options: null as any }))
const dirs = vi.hoisted(() => ({ memories: '' }))
vi.mock('@anthropic-ai/claude-agent-sdk', async () => ({
  ...await vi.importActual('@anthropic-ai/claude-agent-sdk'),
  query: ({ options }: any) => {
    sdk.options = options
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), getContextUsage: async () => null, reloadSkills: async () => ({ skills: [] }), close: vi.fn() }
  }
}))
vi.mock('./config', () => ({ loadConfig: () => ({ windowsControlEnabled: false, ollama: { apiKey: '' } }) }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ dir: '', localDir: '', memoriesDir: dirs.memories, skillsDir: '' }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => true }))
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: vi.fn(), FAST_MODE_TOKEN_SUFFIX: '+fast' }))
vi.mock('./skillManager', () => ({ ensureNativeSkillRoot: () => ({ root: '', errors: [] }), exposeCacheSkills: vi.fn(), managedSkillsFilesystemVersion: () => '', syncCacheSkills: vi.fn() }))
// Seletor TypeSafe ligado, mas sem decisão (timeout/erro): cai na busca reserva.
vi.mock('./memory/memorySelector', async () => ({
  ...await vi.importActual<typeof import('./memory/memorySelector')>('./memory/memorySelector'),
  memorySelectorUsesTypeSafe: async () => true
}))
vi.mock('./typesafe', () => ({ typeSafeMemorySelectionActive: async () => true, selectMemoriesWithTypeSafe: async () => null }))
vi.mock('./projectOutline', () => ({ buildProjectOutline: async () => '[PROJECT_DOCS_CONTEXT]\ndocs/\n[/PROJECT_DOCS_CONTEXT]' }))
vi.mock('./memory/memoryRuntime', () => ({ memoryService: () => null, readSecret: async () => null, readSecretsForPrompt: async () => [], secretSink: () => null, secretVaultEnabled: () => false }))
vi.mock('./persistence/lifecycle', () => ({ storageLifecycle: { repository: () => ({ countConversationsByProject: async () => [], loadConversations: async () => [] }) } }))
vi.mock('./tasks/taskRuntime', () => ({ taskLedger: () => null }))
import { AgentSession } from './agentSession'

let current: AgentSession | null = null
beforeEach(async () => {
  dirs.memories = await mkdtemp(join(tmpdir(), 'memory-fallback-'))
  await writeFile(join(dirs.memories, 'MEMORY.md'), '- [postgres.md](postgres.md): PostgreSQL conexão banco timeout\n- [kotlin.md](kotlin.md): Kotlin gradle android compilação')
  await writeFile(join(dirs.memories, 'postgres.md'), '# PostgreSQL\n\nPostgreSQL conexão banco timeout: consultar o pool de conexões.')
  await writeFile(join(dirs.memories, 'kotlin.md'), '# Kotlin\n\nKotlin gradle android compilação: limpar o cache do gradle.')
})
afterEach(async () => {
  current?.dispose(); current = null
  await rm(dirs.memories, { recursive: true, force: true })
})

async function turn(s: AgentSession, text: string): Promise<string> {
  await s.send(text)
  const out = await sdk.options.hooks.UserPromptSubmit[0].hooks[0]({})
  return out.hookSpecificOutput.additionalContext as string
}

describe('busca reserva de memória (TypeSafe sem decisão)', () => {
  it('a mesma memória vai só na primeira mensagem; uma nova ainda vai', async () => {
    current = new AgentSession({ convId: 'memory-fallback', cwd: '/p' }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn())
    await current.start()
    const first = await turn(current, 'PostgreSQL conexão banco timeout')
    expect(first).toContain('--- Memória relevante: postgres.md ---')
    // Loop de ferramentas do mesmo turno: a escolha é memoizada, nada é reenviado.
    expect(await sdk.options.hooks.PostToolBatch[0].hooks[0]({})).toEqual({})
    const second = await turn(current, 'PostgreSQL conexão banco timeout de novo')
    expect(second).not.toContain('postgres.md')
    const third = await turn(current, 'Kotlin gradle android compilação')
    expect(third).toContain('--- Memória relevante: kotlin.md ---')
    expect(third).not.toContain('postgres.md')
  })
})
