// @vitest-environment node
// O evento `compacting` na AgentSession REAL (`query` é dublê): acende no
// `system/status` 'compacting' do SDK e apaga no status nulo, no
// `compact_boundary` e em qualquer fim de turno (result, erro, interrupção) —
// a linha "Compactando a conversa…" nunca fica presa na tela.
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

let root = ''
const sessions: AgentSession[] = []

async function started(): Promise<{ s: AgentSession; emit: ReturnType<typeof vi.fn> }> {
  const emit = vi.fn()
  const s = new AgentSession({ convId: 'c1', cwd: path.join(root, 'projeto'), model: 'claude-opus-5-5' }, {} as BrowserController, emit, vi.fn(), vi.fn())
  sessions.push(s)
  await s.start()
  return { s, emit }
}

const handle = (s: AgentSession, message: unknown): void =>
  (s as unknown as { handleMessage(m: unknown): void }).handleMessage(message)
const idle = (s: AgentSession): void => (s as unknown as { markTurnIdle(): void }).markTurnIdle()
const compacting = (emit: ReturnType<typeof vi.fn>): boolean[] =>
  emit.mock.calls.filter(([e]) => e.kind === 'compacting').map(([e]) => e.active as boolean)
const status = (extra: Record<string, unknown>) => ({ type: 'system', subtype: 'status', ...extra })

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-compactando-'))
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

describe('AgentSession — evento compacting', () => {
  it('sequência do probe live: acende no compacting, apaga uma vez no status nulo, boundary não repete', async () => {
    const { s, emit } = await started()
    handle(s, status({ status: 'compacting' }))
    handle(s, status({ status: 'compacting' }))
    expect(compacting(emit)).toEqual([true])
    const start = emit.mock.calls.find(([e]) => e.kind === 'compacting')![0]
    expect(typeof start.since).toBe('number')
    handle(s, status({ status: null, compact_result: 'success' }))
    handle(s, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 31527, post_tokens: 2595 } })
    expect(compacting(emit)).toEqual([true, false])
    const notes = emit.mock.calls.filter(([e]) => e.kind === 'status').map(([e]) => e.text)
    expect(notes.some((t: string) => /Conversa compactada \(manual\)/.test(t))).toBe(true)
    expect(notes.some((t: string) => /falhou/.test(t))).toBe(false)
  })

  it('boundary sem status nulo antes também apaga', async () => {
    const { s, emit } = await started()
    handle(s, status({ status: 'compacting' }))
    handle(s, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } })
    expect(compacting(emit)).toEqual([true, false])
  })

  it('falha: apaga e deixa a nota com o erro do SDK', async () => {
    const { s, emit } = await started()
    handle(s, status({ status: 'compacting' }))
    handle(s, status({ status: null, compact_result: 'failed', compact_error: 'prompt too long' }))
    expect(compacting(emit)).toEqual([true, false])
    const notes = emit.mock.calls.filter(([e]) => e.kind === 'status').map(([e]) => e.text)
    expect(notes).toContain('A compactação falhou: prompt too long. A conversa segue sem compactar.')
  })

  it('fim de turno (result, erro, interrupção, travamento) apaga a linha presa', async () => {
    const { s, emit } = await started()
    handle(s, status({ status: 'compacting' }))
    idle(s)
    idle(s)
    expect(compacting(emit)).toEqual([true, false])
  })

  it('status "requesting" não mexe na compactação; fora dela nada é emitido', async () => {
    const { s, emit } = await started()
    handle(s, status({ status: 'requesting' }))
    handle(s, status({ status: null }))
    idle(s)
    expect(compacting(emit)).toEqual([])
    handle(s, status({ status: 'compacting' }))
    handle(s, status({ status: 'requesting' }))
    expect(compacting(emit)).toEqual([true])
  })
})
