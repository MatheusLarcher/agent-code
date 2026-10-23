// @vitest-environment node
// Recusa do modelo na AgentSession REAL (`query` é dublê; as mensagens seguem o
// formato do sdk.d.ts — não dá para provocar uma recusa de verdade): a troca no
// escopo da sessão muda o modelo que responde e vai à tela como `provider-switch`;
// a bolha recusada é reescrita no MESMO id; a de subagente vira só uma linha; a
// recusa sem fallback fica só no log de sessões.
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
import { logSession } from './sessionLog'

let root = ''
const sessions: AgentSession[] = []
type Emit = ReturnType<typeof vi.fn>

interface Internals {
  handleMessage(m: unknown): void
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

const kinds = (emit: Emit, kind: string): Record<string, unknown>[] =>
  emit.mock.calls.filter(([e]) => e.kind === kind).map(([e]) => e as Record<string, unknown>)

/** A resposta parcial recusada como o app a recebe: o streaming e depois a mensagem com uuid. */
function refusedPartial(s: AgentSession): void {
  const stream = (event: unknown) => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: 'u-s', session_id: 's' })
  inner(s).handleMessage(stream({ type: 'message_start', message: { id: 'msg_1' } }))
  inner(s).handleMessage(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Parte que ' } }))
  inner(s).handleMessage({
    type: 'assistant',
    uuid: 'u-recusada',
    session_id: 's',
    parent_tool_use_id: null,
    message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Parte que foi recusada' }] }
  })
}

/** Uma chamada de ferramenta SEM `model` na resposta: o id do modelo do evento é o da sessão. */
function toolCallModel(s: AgentSession, emit: Emit, id: string): unknown {
  inner(s).handleMessage({
    type: 'assistant',
    uuid: `u-${id}`,
    session_id: 's',
    parent_tool_use_id: null,
    message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'a.ts' } }] }
  })
  return kinds(emit, 'tool-use').find((e) => e.id === id)?.model
}

const fallback = (over: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'model_refusal_fallback',
  trigger: 'refusal',
  direction: 'retry',
  scope: 'session',
  original_model: 'claude-opus-5-5',
  fallback_model: 'claude-sonnet-5-5',
  request_id: 'req_1',
  retracted_message_uuids: ['u-recusada', 'u-tool-result-sumido'],
  refused_user_message_uuid: 'u-user',
  content: '',
  uuid: 'u-banner',
  session_id: 's',
  ...over
})

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-recusa-'))
  cacheState.dir = path.join(root, 'cache')
  cacheState.memoriesDir = path.join(root, 'cache', 'memories')
  cacheState.skillsDir = path.join(root, 'cache', 'skills')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  vi.mocked(logSession).mockClear()
  for (const s of sessions.splice(0)) s.dispose()
})

describe('AgentSession — recusa com troca de modelo', () => {
  it('sessão: a bolha recusada é reescrita no mesmo id, a troca vai à tela e a sessão segue no fallback', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    refusedPartial(s)
    expect(toolCallModel(s, emit, 'antes')).toBe('claude-opus-5-5')
    inner(s).handleMessage(fallback())
    const texts = kinds(emit, 'assistant-text')
    expect(texts.map((e) => e.id)).toEqual(['msg_1', 'msg_1', 'msg_1'])
    expect(texts.at(-1)).toEqual({ kind: 'assistant-text', id: 'msg_1', text: '_Resposta recusada pelo Opus 5.5 e refeita no Sonnet 5.5._', final: true })
    expect(kinds(emit, 'provider-switch')).toEqual([
      {
        kind: 'provider-switch',
        id: expect.any(String),
        fromModel: 'claude-opus-5-5',
        model: 'claude-sonnet-5-5',
        effort: 'high',
        fastMode: false,
        text: 'O Opus 5.5 recusou; a conversa seguiu no Sonnet 5.5.'
      }
    ])
    expect(toolCallModel(s, emit, 'depois')).toBe('claude-sonnet-5-5')
    expect(logSession).toHaveBeenCalledWith('model-refusal', { convId: 'c1', model: 'claude-opus-5-5', fallbackModel: 'claude-sonnet-5-5' })
  })

  it('a mesma retirada repetida não reescreve de novo', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    refusedPartial(s)
    inner(s).handleMessage(fallback())
    inner(s).handleMessage(fallback())
    expect(kinds(emit, 'assistant-text').filter((e) => String(e.text).startsWith('_Resposta recusada'))).toHaveLength(1)
  })

  it('local (subagente): só a linha, sem troca e sem mexer no modelo da sessão', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    inner(s).handleMessage(fallback({ scope: 'local', retracted_message_uuids: ['u-do-subagente'] }))
    expect(kinds(emit, 'status').map((e) => e.text)).toEqual(['Um subagente teve a resposta recusada pelo Opus 5.5; refeita no Sonnet 5.5.'])
    expect(kinds(emit, 'provider-switch')).toEqual([])
    expect(kinds(emit, 'assistant-text')).toEqual([])
    expect(toolCallModel(s, emit, 't1')).toBe('claude-opus-5-5')
  })

  it('fora do turno: a sessão troca de modelo, mas nada vai à tela (religaria o "ocupado")', async () => {
    const { s, emit } = await started()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    inner(s).handleMessage(fallback({ retracted_message_uuids: [] }))
    expect(kinds(emit, 'provider-switch')).toEqual([])
    expect(kinds(emit, 'status')).toEqual([])
    expect(log).toHaveBeenCalledTimes(1)
    log.mockRestore()
    expect(toolCallModel(s, emit, 't1')).toBe('claude-sonnet-5-5')
  })
})

describe('AgentSession — recusa sem fallback', () => {
  it('nada na tela (o erro do turno já aparece): só o registro', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    const before = emit.mock.calls.length
    inner(s).handleMessage({
      type: 'system',
      subtype: 'model_refusal_no_fallback',
      original_model: 'claude-opus-5-5',
      request_id: null,
      content: 'recusado',
      uuid: 'u-nf',
      session_id: 's'
    })
    expect(emit.mock.calls.length).toBe(before)
    expect(logSession).toHaveBeenCalledWith('model-refusal', { convId: 'c1', model: 'claude-opus-5-5' })
  })
})
