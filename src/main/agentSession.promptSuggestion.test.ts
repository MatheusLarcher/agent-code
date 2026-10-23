// @vitest-environment node
// Sugestão do próximo prompt na AgentSession REAL (`query` é dublê; a mensagem
// segue o formato do sdk.d.ts): depois do `result` ela vai à tela como estado; com
// um turno novo já aberto é velha e fica de fora; o começo de um turno a limpa.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserController } from './browserController'

const cacheState = vi.hoisted(() => ({ dir: '', memoriesDir: '', skillsDir: '' }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ ...cacheState }) }))
vi.mock('./config', () => ({
  loadConfig: () => ({ windowsControlEnabled: false, ollama: { enabled: false, apiKey: '' }, board: { requirePlan: true } })
}))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => true }))
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: vi.fn(), FAST_MODE_TOKEN_SUFFIX: '+fast' }))
vi.mock('./persistence/lifecycle', () => ({
  storageLifecycle: { repository: () => ({ countConversationsByProject: async () => [] }) }
}))
vi.mock('./projectOutline', () => ({ buildProjectOutline: async () => '' }))
vi.mock('./typesafe', () => ({
  typeSafeMemorySelectionActive: async () => false,
  selectMemoriesWithTypeSafe: async () => null
}))
vi.mock('./memory/memoryRuntime', () => ({
  memoryService: () => ({}),
  secretSink: () => null,
  secretVaultEnabled: () => false,
  readSecret: async () => null,
  readSecretsForPrompt: async () => []
}))
vi.mock('./tasks/taskRuntime', () => ({ taskLedger: () => ({}) }))
vi.mock('./sessionLog', () => ({ logSession: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@anthropic-ai/claude-agent-sdk')
  return { ...actual, query: () => (async function* () {})() }
})

import { AgentSession } from './agentSession'
import { PROMPT_SUGGESTION_MAX } from './promptSuggestion'

let root = ''
const sessions: AgentSession[] = []
type Emit = ReturnType<typeof vi.fn>

interface Internals {
  handleMessage(m: unknown): void
  beginTurn(): void
  turnActive: boolean
}
const inner = (s: AgentSession): Internals => s as unknown as Internals

async function started(): Promise<{ s: AgentSession; emit: Emit }> {
  const emit = vi.fn()
  const s = new AgentSession(
    { convId: 'c1', cwd: path.join(root, 'projeto'), model: 'claude-opus-5-5', effort: 'high' },
    {} as BrowserController,
    emit,
    vi.fn(),
    vi.fn()
  )
  sessions.push(s)
  await s.start()
  return { s, emit }
}

const suggestions = (emit: Emit): unknown[] => emit.mock.calls.filter(([e]) => e.kind === 'prompt-suggestion').map(([e]) => e)
const suggestion = (text: unknown) => ({ type: 'prompt_suggestion', suggestion: text, uuid: 'u-s', session_id: 's' })

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-sugestao-'))
  cacheState.dir = path.join(root, 'cache')
  cacheState.memoriesDir = path.join(root, 'cache', 'memories')
  cacheState.skillsDir = path.join(root, 'cache', 'skills')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
})

describe('AgentSession — sugestão do próximo prompt', () => {
  it('depois do result (fora do turno): vai à tela como estado, sem espaços nas pontas', async () => {
    const { s, emit } = await started()
    inner(s).handleMessage(suggestion('  Agora o 2º passo.  '))
    expect(suggestions(emit)).toEqual([{ kind: 'prompt-suggestion', text: 'Agora o 2º passo.' }])
  })

  it('chegou com um turno novo já aberto: é do turno anterior e fica de fora', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    inner(s).handleMessage(suggestion('Rode os testes'))
    expect(suggestions(emit)).toEqual([])
  })

  it('vazia, sem texto ou longa demais: nada vai à tela', async () => {
    const { s, emit } = await started()
    for (const text of ['', '   ', undefined, 42, 'x'.repeat(PROMPT_SUGGESTION_MAX + 1)]) inner(s).handleMessage(suggestion(text))
    expect(suggestions(emit)).toEqual([])
    inner(s).handleMessage(suggestion('x'.repeat(PROMPT_SUGGESTION_MAX)))
    expect(suggestions(emit)).toHaveLength(1)
  })

  it('o começo de um turno manda null: o chip some no PC e no celular', async () => {
    const { s, emit } = await started()
    inner(s).handleMessage(suggestion('Faça o commit'))
    inner(s).beginTurn()
    expect(suggestions(emit)).toEqual([
      { kind: 'prompt-suggestion', text: 'Faça o commit' },
      { kind: 'prompt-suggestion', text: null }
    ])
  })
})
