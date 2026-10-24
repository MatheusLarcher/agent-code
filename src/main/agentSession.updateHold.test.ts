// @vitest-environment node
// A retenção da atualização ("quando os agentes terminarem") recusa turno NOVO
// no hook UserPromptSubmit com a mesma mensagem do coordenador — e só isso: as
// ferramentas e permissões do turno em curso não são negadas (isso é a reserva
// do app_restart, que continua separada).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserController } from './browserController'

const runtime = vi.hoisted(() => ({
  appRestart: { reserved: false, updateHold: false, register: () => ({ request: () => undefined, othersWorking: () => undefined, remove: () => undefined }) }
}))
vi.mock('./appRestartRuntime', () => runtime)
const cacheState = vi.hoisted(() => ({ dir: '', memoriesDir: '', skillsDir: '' }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ ...cacheState }) }))
vi.mock('./config', () => ({
  loadConfig: () => ({ windowsControlEnabled: false, ollama: { enabled: false, apiKey: '' }, board: { requirePlan: true } })
}))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => false }))
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
const queryMock = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@anthropic-ai/claude-agent-sdk')
  return {
    ...actual,
    query: (...args: unknown[]) => {
      queryMock(...args)
      return (async function* () {})()
    }
  }
})

import { AgentSession } from './agentSession'
import { UPDATE_HOLD_MESSAGE } from './appRestart'

let root = ''
const sessions: AgentSession[] = []
type Hook = (input: Record<string, unknown>) => Promise<unknown>

async function startedHooks(): Promise<{ prompt: Hook; pre: Hook }> {
  const s = new AgentSession(
    { convId: 'c1', cwd: path.join(root, 'projeto'), model: 'claude-opus-5-5', effort: 'high' },
    {} as BrowserController,
    vi.fn(),
    vi.fn(),
    vi.fn()
  )
  sessions.push(s)
  await s.start()
  const options = queryMock.mock.calls.at(-1)![0].options as { hooks: Record<string, Array<{ hooks: Hook[] }>> }
  return { prompt: options.hooks.UserPromptSubmit[0].hooks[0], pre: options.hooks.PreToolUse[0].hooks[0] }
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-hold-'))
  cacheState.dir = path.join(root, 'cache')
  cacheState.memoriesDir = path.join(root, 'cache', 'memories')
  cacheState.skillsDir = path.join(root, 'cache', 'skills')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})
afterEach(() => {
  runtime.appRestart.updateHold = false
  runtime.appRestart.reserved = false
  for (const s of sessions.splice(0)) s.dispose()
})

describe('AgentSession — retenção da atualização', () => {
  it('turno novo é bloqueado com a mensagem da retenção', async () => {
    const { prompt } = await startedHooks()
    runtime.appRestart.updateHold = true
    await expect(prompt({ hook_event_name: 'UserPromptSubmit' })).resolves.toEqual({ decision: 'block', reason: UPDATE_HOLD_MESSAGE })
  })

  it('sem retenção o turno segue; e a retenção não nega ferramentas do turno em curso', async () => {
    const { prompt, pre } = await startedHooks()
    await expect(prompt({ hook_event_name: 'UserPromptSubmit' })).resolves.not.toHaveProperty('decision')
    runtime.appRestart.updateHold = true
    const decision = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a.ts' } })
    expect(decision).not.toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })
})
