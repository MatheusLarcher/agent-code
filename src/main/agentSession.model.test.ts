// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserController } from './browserController'
import type { ChatEvent } from '../shared/ipc'
import type { ContextHistoryRepository, ContextTurnWrite } from './persistence/types'
import { readLiveContext } from './contextSnapshot/capture'
const sdk = vi.hoisted(() => ({ options: null as any }))
vi.mock('@anthropic-ai/claude-agent-sdk', async () => ({
  ...await vi.importActual('@anthropic-ai/claude-agent-sdk'),
  query: ({ options }: any) => {
    sdk.options = options
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), getContextUsage: async () => null, reloadSkills: async () => ({ skills: [] }), close: vi.fn() }
  }
}))
vi.mock('./config', () => ({ loadConfig: () => ({ windowsControlEnabled: false, ollama: { apiKey: '' } }) }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ dir: '', localDir: '', memoriesDir: '', skillsDir: '' }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => true }))
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: vi.fn(), FAST_MODE_TOKEN_SUFFIX: '+fast' }))
vi.mock('./skillManager', () => ({ ensureNativeSkillRoot: () => ({ root: '', errors: [] }), exposeCacheSkills: vi.fn(), managedSkillsFilesystemVersion: () => '', syncCacheSkills: vi.fn() }))
vi.mock('./typesafe', () => ({ typeSafeMemorySelectionActive: async () => false, selectMemoriesWithTypeSafe: async () => null }))
vi.mock('./projectOutline', () => ({ buildProjectOutline: async () => '' }))
vi.mock('./memory/memoryRuntime', () => ({ memoryService: () => null, readSecret: async () => null, readSecretsForPrompt: async () => [], secretSink: () => null, secretVaultEnabled: () => false }))
vi.mock('./persistence/lifecycle', () => ({ storageLifecycle: { repository: () => ({ countConversationsByProject: async () => [], loadConversations: async () => [] }) } }))
vi.mock('./tasks/taskRuntime', () => ({ taskLedger: () => null }))
import { AgentSession } from './agentSession'

const OPUS = 'claude-opus-5-5'
const SOL = 'gpt-6.1-sol'
let current: AgentSession | null = null
afterEach(() => { current?.dispose(); current = null })

function session(convId: string, model?: string) {
  const events: ChatEvent[] = []
  const repo = { saveContextTurn: async (_w: ContextTurnWrite) => undefined } as unknown as ContextHistoryRepository
  current = new AgentSession({ convId, cwd: '/p', model }, {} as BrowserController, (e) => { events.push(e) }, vi.fn(), vi.fn(),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, repo)
  return { s: current, events }
}
const feed = (s: AgentSession, message: unknown): void => { (s as any).handleMessage(message) }
const init = (model: string) => ({ type: 'system', subtype: 'init', session_id: 'sess', model, cwd: '/p', tools: [] })
const assistant = (id: string, model: string | undefined, parent: string | null = null, name = 'Read') => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { ...(model !== undefined ? { model } : {}), content: [{ type: 'tool_use', id, name, input: { file_path: 'a.ts' } }] }
})
const toolUses = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { kind: 'tool-use' }> => e.kind === 'tool-use')
const llmCalls = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { kind: 'llm-call' }> => e.kind === 'llm-call')

describe('AgentSession — modelo que fez cada tarefa', () => {
  it('o tool-use sai com o modelo da mensagem que o trouxe, também no subagente', async () => {
    const { s, events } = session('model-per-action', OPUS)
    await s.start()
    feed(s, assistant('t1', OPUS))
    feed(s, assistant('t2', 'claude-haiku-4-5', 'task-1'))
    expect(toolUses(events).map((e) => [e.id, e.model, e.parentToolUseId])).toEqual([
      ['t1', OPUS, null],
      ['t2', 'claude-haiku-4-5', 'task-1']
    ])
    expect(llmCalls(events).map((e) => e.model)).toEqual([OPUS, 'claude-haiku-4-5'])
  })

  it('resposta sem modelo cai no modelo da sessão (init), nunca no sentinela do Automático', async () => {
    const { s, events } = session('model-fallback', 'auto')
    await s.start()
    // Antes do init não há modelo conhecido: o tool-use sai sem o campo.
    feed(s, assistant('t0', undefined))
    feed(s, init(SOL))
    feed(s, assistant('t1', undefined))
    feed(s, assistant('t2', 'auto'))
    const uses = toolUses(events)
    expect('model' in uses[0]).toBe(false)
    expect(uses.slice(1).map((e) => e.model)).toEqual([SOL, SOL])
    expect(llmCalls(events).map((e) => e.model)).toEqual(['', SOL, SOL])
    expect(JSON.stringify(events)).not.toMatch(/"model":"auto"/)
  })

  it('sem init, cai no modelo escolhido quando ele é concreto', async () => {
    const { s, events } = session('model-opts', OPUS)
    await s.start()
    feed(s, assistant('t1', undefined))
    expect(toolUses(events)[0].model).toBe(OPUS)
  })

  it('turno com respostas de dois modelos guarda os dois na ordem e cada ação com o seu', async () => {
    const { s, events } = session('model-two', OPUS)
    await s.start()
    await s.send('arruma', undefined, 'turn-1')
    feed(s, assistant('t1', OPUS))
    feed(s, assistant('t2', OPUS))
    feed(s, assistant('t3', SOL))
    expect(readLiveContext('model-two', 'turn-1')!.models).toEqual([
      { model: OPUS, calls: 2, node: null },
      { model: SOL, calls: 1, node: null }
    ])
    expect(toolUses(events).map((e) => e.model)).toEqual([OPUS, OPUS, SOL])
  })

  it('a continuação interna (recovery) segue no turno do usuário', async () => {
    const { s } = session('model-recovery', OPUS)
    await s.start()
    await s.send('pedido', undefined, 'turn-1')
    feed(s, assistant('t1', OPUS))
    feed(s, { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, result: 'ok', usage: {}, user_message_uuid: 'turn-1' })
    await s.send('Continue de onde parou.', undefined, 'cont-1', 'pc', 'recovery')
    feed(s, assistant('t2', SOL))
    const detail = readLiveContext('model-recovery', 'turn-1')!
    expect(detail.models.map((m) => m.model)).toEqual([OPUS, SOL])
    expect(detail.blocks.some((b) => b.source === 'continuation' && b.text === 'Continue de onde parou.')).toBe(true)
    expect(readLiveContext('model-recovery', 'cont-1')!.turnId).toBe('turn-1')
  })
})
