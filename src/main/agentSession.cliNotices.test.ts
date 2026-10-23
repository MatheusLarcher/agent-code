// @vitest-environment node
// Avisos do CLI na AgentSession REAL (`query` é dublê): o `api_retry` acende o
// evento `api-retry` e apaga na próxima resposta ou no fim do turno; a negação
// sem perguntar, o `informational` e a `notification` viram linha `status` (só
// com o turno aberto); e o watchdog não acusa "sem resposta" nem aborta enquanto
// o app espera o usuário ou a nova tentativa agendada.
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
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@anthropic-ai/claude-agent-sdk')
  return { ...actual, query: () => (async function* () {})() }
})

import { AgentSession } from './agentSession'
import { STALL_ABORT_MS, STALL_THRESHOLD_MS } from './stallWatch'

let root = ''
const sessions: AgentSession[] = []
type Emit = ReturnType<typeof vi.fn>

interface Internals {
  handleMessage(m: unknown): void
  markTurnIdle(): void
  checkStall(): void
  turnActive: boolean
  lastActivityAt: number
  pendingPermissions: Map<string, unknown>
  q: unknown
}
const inner = (s: AgentSession): Internals => s as unknown as Internals

async function started(): Promise<{ s: AgentSession; emit: Emit }> {
  const emit = vi.fn()
  const s = new AgentSession({ convId: 'c1', cwd: path.join(root, 'projeto'), model: 'claude-opus-5-5' }, {} as BrowserController, emit, vi.fn(), vi.fn())
  sessions.push(s)
  await s.start()
  return { s, emit }
}

const kinds = (emit: Emit, kind: string): Record<string, unknown>[] =>
  emit.mock.calls.filter(([e]) => e.kind === kind).map(([e]) => e as Record<string, unknown>)
const retry = (over: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'api_retry',
  attempt: 3,
  max_retries: 10,
  retry_delay_ms: 12_000,
  error_status: 529,
  error: 'overloaded',
  uuid: 'u',
  session_id: 's',
  ...over
})

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-avisos-cli-'))
  cacheState.dir = path.join(root, 'cache')
  cacheState.memoriesDir = path.join(root, 'cache', 'memories')
  cacheState.skillsDir = path.join(root, 'cache', 'skills')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  vi.useRealTimers()
  for (const s of sessions.splice(0)) s.dispose()
})

describe('AgentSession — api_retry', () => {
  it('acende com o motivo e o prazo; a próxima resposta apaga uma vez', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    const before = Date.now()
    inner(s).handleMessage(retry())
    const [on] = kinds(emit, 'api-retry')
    expect(on).toMatchObject({ active: true, attempt: 3, maxRetries: 10, status: 529, error: 'overloaded' })
    expect(on.retryAt as number).toBeGreaterThanOrEqual(before + 12_000)
    inner(s).handleMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } }, parent_tool_use_id: null })
    inner(s).handleMessage({ type: 'stream_event', event: { type: 'ping' }, parent_tool_use_id: null })
    expect(kinds(emit, 'api-retry').map((e) => e.active)).toEqual([true, false])
  })

  it('cada nova tentativa reemite; o fim do turno apaga (sem repetir)', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    inner(s).handleMessage(retry({ attempt: 1 }))
    inner(s).handleMessage(retry({ attempt: 2, error_status: null, error: 'unknown' }))
    inner(s).markTurnIdle()
    inner(s).markTurnIdle()
    const seen = kinds(emit, 'api-retry')
    expect(seen.map((e) => e.active)).toEqual([true, true, false])
    expect(seen[1]).toMatchObject({ attempt: 2, status: null })
  })

  it('fora do turno não acende nada', async () => {
    const { s, emit } = await started()
    inner(s).handleMessage(retry())
    expect(kinds(emit, 'api-retry')).toEqual([])
  })
})

describe('AgentSession — watchdog com espera legítima', () => {
  it('retry agendado: nada de "sem resposta" até retryAt + 60 s; depois, o aviso de sempre', async () => {
    const { s, emit } = await started()
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    inner(s).turnActive = true
    inner(s).handleMessage(retry({ retry_delay_ms: 120_000 }))
    vi.setSystemTime(t0 + 120_000 + 60_000)
    inner(s).checkStall()
    expect(kinds(emit, 'stall-status')).toEqual([])
    vi.setSystemTime(t0 + 120_000 + 60_001)
    inner(s).checkStall()
    expect(kinds(emit, 'stall-status').map((e) => e.stalled)).toEqual([true])
  })

  it('permissão pendente: nem aviso nem abort; respondida, a contagem recomeça', async () => {
    const { s, emit } = await started()
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    inner(s).turnActive = true
    inner(s).lastActivityAt = t0
    inner(s).pendingPermissions.set('p1', { toolName: 'Bash', resolve: () => undefined })
    vi.setSystemTime(t0 + STALL_ABORT_MS + 5_000)
    inner(s).checkStall()
    expect(kinds(emit, 'stall-status')).toEqual([])
    expect(kinds(emit, 'error')).toEqual([])
    inner(s).pendingPermissions.delete('p1')
    vi.setSystemTime(t0 + STALL_ABORT_MS + 10_000)
    inner(s).checkStall()
    expect(kinds(emit, 'stall-status')).toEqual([])
    expect(kinds(emit, 'error')).toEqual([])
    vi.setSystemTime(t0 + STALL_ABORT_MS + 5_000 + STALL_THRESHOLD_MS + 1)
    inner(s).checkStall()
    expect(kinds(emit, 'stall-status').map((e) => e.stalled)).toEqual([true])
  })

  it('aviso já aceso apaga quando a espera pelo usuário começa', async () => {
    const { s, emit } = await started()
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    inner(s).turnActive = true
    inner(s).lastActivityAt = t0
    vi.setSystemTime(t0 + STALL_THRESHOLD_MS + 1)
    inner(s).checkStall()
    inner(s).pendingPermissions.set('p1', { toolName: 'AskUserQuestion', resolve: () => undefined })
    inner(s).checkStall()
    expect(kinds(emit, 'stall-status').map((e) => e.stalled)).toEqual([true, false])
  })

  it('sem espera nenhuma: aviso e abort como antes', async () => {
    const { s, emit } = await started()
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    inner(s).turnActive = true
    inner(s).lastActivityAt = t0
    vi.setSystemTime(t0 + STALL_ABORT_MS + 1)
    inner(s).checkStall()
    expect(kinds(emit, 'error')[0]).toMatchObject({ incomplete: true, retryable: true })
  })
})

describe('AgentSession — avisos do CLI no chat', () => {
  const denied = (type?: string) => ({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    ...(type ? { decision_reason_type: type } : {}),
    message: 'Permission to use Bash with command echo probe-negado has been denied.',
    uuid: 'u',
    session_id: 's'
  })
  const statusTexts = (emit: Emit): string[] => kinds(emit, 'status').map((e) => e.text as string)

  it('negação por regra vira linha; a do hook do app não', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    inner(s).handleMessage(denied('rule'))
    inner(s).handleMessage(denied('hook'))
    expect(statusTexts(emit)).toEqual([
      'Negado sem perguntar (regra de permissão): Bash — Permission to use Bash with command echo probe-negado has been denied.'
    ])
  })

  it('informational e notification: só o que o CLI mostra em destaque', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    inner(s).handleMessage({ type: 'system', subtype: 'informational', content: 'só no modo transcrição', level: 'info' })
    inner(s).handleMessage({ type: 'system', subtype: 'informational', content: 'Hook pediu para parar', level: 'warning' })
    inner(s).handleMessage({ type: 'system', subtype: 'notification', key: 'a', text: 'baixa', priority: 'low' })
    inner(s).handleMessage({ type: 'system', subtype: 'notification', key: 'b', text: 'Contexto quase cheio', priority: 'high' })
    expect(statusTexts(emit)).toEqual(['Hook pediu para parar', 'Contexto quase cheio'])
  })

  it('fora do turno nada vira linha (um status religaria o "ocupado" da tela)', async () => {
    const { s, emit } = await started()
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    inner(s).handleMessage(denied('asyncAgent'))
    inner(s).handleMessage({ type: 'system', subtype: 'notification', key: 'b', text: 'Contexto quase cheio', priority: 'high' })
    expect(statusTexts(emit)).toEqual([])
    expect(log).toHaveBeenCalledTimes(2)
    log.mockRestore()
  })

  it('os subtipos novos não chegam ao tradutor de tarefas', async () => {
    const { s, emit } = await started()
    inner(s).turnActive = true
    inner(s).handleMessage(retry())
    inner(s).handleMessage(denied('rule'))
    expect(kinds(emit, 'agent-task')).toEqual([])
  })
})
