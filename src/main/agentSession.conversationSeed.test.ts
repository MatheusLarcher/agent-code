// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserController } from './browserController'
// Sessão retomada: a conversa gravada entra no resumo que o Haiku vê
// (memory/conversationSeed.ts), sem segurar o envio.
const sdk = vi.hoisted(() => ({ messages: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []) }))
const haiku = vi.hoisted(() => ({ seen: [] as string[] }))
vi.mock('@anthropic-ai/claude-agent-sdk', async () => ({
  ...await vi.importActual('@anthropic-ai/claude-agent-sdk'),
  getSessionMessages: (...args: unknown[]) => sdk.messages(...args),
  query: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }), reloadSkills: async () => ({ skills: [] }), close: vi.fn() })
}))
vi.mock('./config', () => ({ loadConfig: () => ({ windowsControlEnabled: false, ollama: { apiKey: '' }, memorySelector: 'haiku' }) }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ dir: '', localDir: '', memoriesDir: '', skillsDir: '' }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => true }))
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: vi.fn(), FAST_MODE_TOKEN_SUFFIX: '+fast' }))
vi.mock('./skillManager', () => ({ ensureNativeSkillRoot: () => ({ root: '', errors: [] }), exposeCacheSkills: vi.fn(), managedSkillsFilesystemVersion: () => '', syncCacheSkills: vi.fn() }))
vi.mock('./typesafe', () => ({ typeSafeMemorySelectionActive: async () => false, selectMemoriesWithTypeSafe: async () => null }))
vi.mock('./projectOutline', () => ({ buildProjectOutline: async () => '' }))
vi.mock('./memorySelectionHaiku', async () => ({
  ...await vi.importActual<typeof import('./memorySelectionHaiku')>('./memorySelectionHaiku'),
  selectMemoriesWithHaiku: async (_dir: string, _query: string, opts?: { conversation?: (max: number) => string }) => {
    haiku.seen.push(opts?.conversation?.(100_000) ?? '<sem resumo>')
    return { block: '', relPaths: [], entries: [] }
  }
}))
vi.mock('./memory/memoryRuntime', () => ({ memoryService: () => null, readSecret: async () => null, readSecretsForPrompt: async () => [], secretSink: () => null, secretVaultEnabled: () => false }))
vi.mock('./persistence/lifecycle', () => ({ storageLifecycle: { repository: () => ({ countConversationsByProject: async () => [], loadConversations: async () => [] }) } }))
vi.mock('./tasks/taskRuntime', () => ({ taskLedger: () => null }))
import { AgentSession, CONVERSATION_SEED_WAIT_MS } from './agentSession'

const STAMP = '[Contexto do sistema: mensagem enviada do PC MAQ em 14/10/2026, 22:00:00 (America/Sao_Paulo).]'
const recorded = [
  { type: 'system', uuid: 'x0', session_id: 'sess-1', message: {}, parent_tool_use_id: null, parent_agent_id: null },
  {
    type: 'user', uuid: 'x1', session_id: 'sess-1', parent_tool_use_id: null, parent_agent_id: null,
    message: { role: 'user', content: `${STAMP}\n\n[SKILL_CATALOG_UPDATE]\n- skill\n[/SKILL_CATALOG_UPDATE]\n\nqual o banco do ERP?` }
  },
  {
    type: 'assistant', uuid: 'x2', session_id: 'sess-1', parent_tool_use_id: null, parent_agent_id: null,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pensando' }, { type: 'text', text: 'É o FALCAO.' }, { type: 'tool_use', id: 't1', name: 'Read', input: {} }] }
  },
  {
    type: 'assistant', uuid: 'x3', session_id: 'sess-1', parent_tool_use_id: 't1', parent_agent_id: 'sub',
    message: { role: 'assistant', content: [{ type: 'text', text: 'fala do subagente' }] }
  }
]

let current: AgentSession | null = null
function session(resume?: string): AgentSession {
  current = new AgentSession({ convId: 'seed-conv', cwd: '/p', resume }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn())
  return current
}

beforeEach(() => {
  haiku.seen = []
  sdk.messages.mockReset()
  sdk.messages.mockImplementation(async () => [])
})
afterEach(() => {
  vi.useRealTimers()
  current?.dispose()
  current = null
})

describe('AgentSession — resumo da conversa numa sessão retomada', () => {
  it('a retomada semeia o resumo uma vez, limpo, antes da primeira escolha do Haiku', async () => {
    sdk.messages.mockImplementation(async () => recorded)
    const s = session('sess-1')
    await s.start()
    await s.send('e a porta?')
    await s.send('e o usuário?')
    expect(haiku.seen).toEqual([
      'Usuário: qual o banco do ERP?\n\nAssistente: É o FALCAO.',
      'Usuário: qual o banco do ERP?\n\nAssistente: É o FALCAO.\n\nUsuário: e a porta?'
    ])
    expect(sdk.messages).toHaveBeenCalledTimes(1)
    expect(sdk.messages).toHaveBeenCalledWith('sess-1', { dir: '/p' })
  })

  it('sem retomada não lê a gravação', async () => {
    const s = session()
    await s.start()
    await s.send('oi')
    expect(sdk.messages).not.toHaveBeenCalled()
    expect(haiku.seen).toEqual([''])
  })

  it('loader que falha deixa o resumo vazio e o envio segue', async () => {
    sdk.messages.mockImplementation(async () => {
      throw new Error('transcrição ilegível')
    })
    const s = session('sess-1')
    await expect(s.start()).resolves.toBe(true)
    await s.send('oi')
    expect(haiku.seen).toEqual([''])
    expect(String((s as unknown as { input: { values: Array<{ message: { content: unknown } }> } }).input.values.at(-1)!.message.content)).toContain('oi')
  })

  it('carga lenta não segura o envio além do teto; quando chega, entra antes da conversa atual', async () => {
    let release: (value: unknown[]) => void = () => {}
    sdk.messages.mockImplementation(() => new Promise<unknown[]>((resolve) => { release = resolve }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = session('sess-1')
    await s.start()
    let sent = false
    const sending = s.send('primeiro').then(() => { sent = true })
    for (let waited = 0; !sent && waited <= CONVERSATION_SEED_WAIT_MS * 3; waited += 100) {
      await vi.advanceTimersByTimeAsync(100)
      await new Promise((resolve) => setImmediate(resolve))
    }
    await sending
    expect(haiku.seen).toEqual([''])
    vi.useRealTimers()

    release(recorded)
    await new Promise((resolve) => setImmediate(resolve))
    await s.send('segundo')
    expect(haiku.seen.at(-1)).toBe('Usuário: qual o banco do ERP?\n\nAssistente: É o FALCAO.\n\nUsuário: primeiro')
  })
})
