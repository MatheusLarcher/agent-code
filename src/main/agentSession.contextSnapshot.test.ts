// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserController } from './browserController'
import type { ContextHistoryRepository, ContextTurnWrite } from './persistence/types'
import { composeFromPromptBlocks } from './contextSnapshot/blocks'
import { readLiveContext } from './contextSnapshot/capture'
const sdk = vi.hoisted(() => ({ options: null as any, usage: vi.fn(async () => ({ totalTokens: 8, maxTokens: 100, percentage: 8, categories: [] })) }))
const context = vi.hoisted(() => ({ docs: '[PROJECT_DOCS_CONTEXT]\ndocs/\n[/PROJECT_DOCS_CONTEXT]', memory: '--- Memória relevante: lexical.md ---\nconteúdo', lexicalDir: '' }))
vi.mock('@anthropic-ai/claude-agent-sdk', async () => ({
  ...await vi.importActual('@anthropic-ai/claude-agent-sdk'),
  query: ({ options }: any) => {
    sdk.options = options
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), getContextUsage: sdk.usage, reloadSkills: async () => ({ skills: [] }), close: vi.fn() }
  }
}))
vi.mock('./config', () => ({ loadConfig: () => ({ windowsControlEnabled: false, ollama: { apiKey: '' } }) }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ dir: '', localDir: '', memoriesDir: context.lexicalDir, skillsDir: '' }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => true }))
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: vi.fn(), FAST_MODE_TOKEN_SUFFIX: '+fast' }))
vi.mock('./skillManager', () => ({ ensureNativeSkillRoot: () => ({ root: '', errors: [] }), exposeCacheSkills: vi.fn(), managedSkillsFilesystemVersion: () => '', syncCacheSkills: vi.fn() }))
vi.mock('./typesafe', () => ({ typeSafeMemorySelectionActive: async () => false, selectMemoriesWithTypeSafe: async () => null }))
vi.mock('./projectOutline', () => ({ buildProjectOutline: async () => context.docs }))
vi.mock('./memoryIndex', async () => {
  const actual = await vi.importActual<typeof import('./memoryIndex')>('./memoryIndex')
  return { ...actual, buildDynamicMemoryContext: (...args: Parameters<typeof actual.buildDynamicMemoryContext>) => context.lexicalDir ? actual.buildDynamicMemoryContext(...args) : context.memory }
})
vi.mock('./memory/memoryRuntime', () => ({ memoryService: () => null, readSecret: async () => null, readSecretsForPrompt: async () => [{ name: 'vault', value: 'TEST-PASSWORD' }], secretSink: () => null, secretVaultEnabled: () => false }))
vi.mock('./persistence/lifecycle', () => ({ storageLifecycle: { repository: () => ({ countConversationsByProject: async () => [], loadConversations: async () => [] }) } }))
vi.mock('./tasks/taskRuntime', () => ({ taskLedger: () => null }))
vi.mock('./visionRelay', async () => ({ ...await vi.importActual('./visionRelay'), describeImages: async () => 'descrição visual' }))
import { AgentSession } from './agentSession'
let current: AgentSession | null = null
afterEach(() => { current?.dispose(); current = null })
function session(model?: string) {
  const writes: ContextTurnWrite[] = []
  const repo = { saveContextTurn: async (w: ContextTurnWrite) => { writes.push(w) } } as ContextHistoryRepository
  current = new AgentSession({ convId: 'capture-integration', cwd: '/p', model }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, repo)
  return { s: current, writes }
}
function feed(s: AgentSession, message: unknown) { (s as any).handleMessage(message) }
async function settled() { await new Promise((r) => setTimeout(r, 20)) }
describe('AgentSession context origin', () => {
  it('deriva nomes do trecho lexical real com TypeSafe desligado', async () => {
    context.lexicalDir = await mkdtemp(join(tmpdir(), 'context-lexical-'))
    try {
      await writeFile(join(context.lexicalDir, 'MEMORY.md'), '- [postgres.md](postgres.md): PostgreSQL conexão banco diagnóstico timeout')
      await writeFile(join(context.lexicalDir, 'postgres.md'), '# PostgreSQL\n\nPostgreSQL conexão banco diagnóstico timeout precisa consultar o pool de conexões.')
      const { s } = session()
      await s.start(); await s.send('PostgreSQL conexão banco diagnóstico timeout', undefined, 'lexical-uuid')
      await sdk.options.hooks.UserPromptSubmit[0].hooks[0]({})
      expect(readLiveContext('capture-integration', 'lexical-uuid')!.memoriesSent).toEqual(['postgres.md'])
    } finally { await rm(context.lexicalDir, { recursive: true, force: true }); context.lexicalDir = '' }
  })
  it.each(['claude-sonnet-5-5', 'glm-5.3:cloud'])('captura imagem só por contagem e texto entregue pela rota %s', async (model) => {
    const { s } = session(model)
    await s.send('pedido', [{ mediaType: 'image/png', data: 'AAAA' }], 'image-uuid')
    const content = (s as any).input.values.at(-1).message.content
    const text = typeof content === 'string' ? content : content.at(-1).text
    const detail = readLiveContext('capture-integration', 'image-uuid')!
    expect(composeFromPromptBlocks(detail.blocks.filter((b) => b.source === 'prompt'))).toBe(text)
    expect(detail.blocks.find((b) => b.kind === 'images')!.text).toContain('1 imagem')
    expect(JSON.stringify(detail)).not.toContain('AAAA')
    if (model.startsWith('glm')) expect(text).toContain('[VISUAL_CONTEXT]')
  })
  it('separa a nota de cancelamento sem mudar a mensagem entregue', async () => {
    const { s } = session('claude-sonnet-5-5')
    ;(s as any).canceledPending = true
    await s.send('novo pedido', undefined, 'cancel-uuid')
    const detail = readLiveContext('capture-integration', 'cancel-uuid')!
    expect(detail.blocks.some((b) => b.kind === 'cancel-note')).toBe(true)
    expect(composeFromPromptBlocks(detail.blocks.filter((b) => b.source === 'prompt'))).toBe((s as any).input.values.at(-1).message.content)
  })
  it('tool-use Agent conserva definição de especialista mais input pelo parentToolUseId', async () => {
    const { s } = session()
    await s.start(); await s.send('delegue', undefined, 'agent-uuid')
    feed(s, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'task-nav', name: 'Agent', input: { subagent_type: 'navegador-de-codigo', prompt: 'procure arquivo' } }] } })
    const child = readLiveContext('capture-integration', 'agent-uuid', 'task-nav')!
    expect(child.blocks.map((b) => b.text)).toEqual([sdk.options.agents['navegador-de-codigo'].prompt, 'procure arquivo'])
    expect(readLiveContext('capture-integration', 'agent-uuid')!.blocks.some((b) => b.source === 'subagent')).toBe(false)
  })
  it('captura o texto exato do envio e hooks start/mid, memória lexical e result principal', async () => {
    const { s, writes } = session()
    await s.start()
    await s.send('pedido TEST-PASSWORD', undefined, 'user-uuid')
    const sent = (s as any).input.values.at(-1)
    expect(sent.uuid).toBe('user-uuid')
    const first = await sdk.options.hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt: sent.message.content })
    let detail = readLiveContext('capture-integration', 'user-uuid')!
    expect(detail).not.toBeNull()
    expect(composeFromPromptBlocks(detail.blocks.filter((b) => b.source === 'prompt'))).toBe(sent.message.content.replaceAll('TEST-PASSWORD', '⟦senha:vault⟧'))
    expect(detail.blocks.filter((b) => b.source === 'hook-start').map((b) => b.text).join('\n\n')).toBe(first.hookSpecificOutput.additionalContext)
    expect(detail.memoriesSent).toEqual(['lexical.md'])
    expect(await sdk.options.hooks.PostToolBatch[0].hooks[0]({})).toEqual({})
    context.docs += '\neditado'
    const mid = await sdk.options.hooks.PostToolBatch[0].hooks[0]({})
    detail = readLiveContext('capture-integration', 'user-uuid')!
    expect(detail.blocks.filter((b) => b.source === 'hook-mid').map((b) => b.text).join('\n\n')).toBe(mid.hookSpecificOutput.additionalContext)
    feed(s, { type: 'result', origin: { kind: 'peer' } })
    expect(readLiveContext('capture-integration', 'user-uuid')!.complete).toBe(false)
    feed(s, { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, result: 'ok', usage: {}, user_message_uuid: 'user-uuid' })
    await settled()
    expect(readLiveContext('capture-integration', 'user-uuid')).toMatchObject({ complete: true, usage: { totalTokens: 8 } })
    expect(JSON.stringify(writes)).not.toContain('TEST-PASSWORD')
  })
})
