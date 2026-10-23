// @vitest-environment node
// Parar UMA tarefa de fundo na AgentSession REAL (`query` é dublê): sem query
// não há o que parar; com ela, o `stopTask` do SDK recebe o id e o log de
// sessões registra o pedido — e uma recusa do SDK vira `false`, nunca exceção.
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

function session(): AgentSession {
  const s = new AgentSession({ convId: 'c1', cwd: path.join(root, 'projeto'), model: 'claude-opus-5-5' }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn())
  sessions.push(s)
  return s
}
/** A query viva de mentira: só o que o teste usa (e o `close` do dispose). */
const withQuery = (s: AgentSession, stopTask: (id: string) => Promise<void>): void => {
  ;(s as unknown as { q: unknown }).q = { stopTask, close: () => undefined }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-parar-tarefa-'))
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

describe('AgentSession.stopTask', () => {
  it('sem query: false, sem chamar nada', async () => {
    expect(await session().stopTask('t1')).toBe(false)
    expect(logSession).not.toHaveBeenCalled()
  })

  it('com query: o SDK recebe o id e o log registra', async () => {
    const s = session()
    const stopTask = vi.fn(async () => undefined)
    withQuery(s, stopTask)
    expect(await s.stopTask('b3k9x2')).toBe(true)
    expect(stopTask).toHaveBeenCalledWith('b3k9x2')
    expect(logSession).toHaveBeenCalledWith('task-stop', { convId: 'c1', taskId: 'b3k9x2', threw: false })
  })

  it('o SDK recusou: false, com o registro da falha', async () => {
    const s = session()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    withQuery(s, async () => {
      throw new Error('task not found')
    })
    expect(await s.stopTask('sumida')).toBe(false)
    expect(logSession).toHaveBeenCalledWith('task-stop', { convId: 'c1', taskId: 'sumida', threw: true })
    warn.mockRestore()
  })
})
