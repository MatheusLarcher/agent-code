// @vitest-environment node
// O aviso de prazo na AgentSession REAL: start() montando as Options do SDK (sem
// subir o SDK — `query` é dublê) e o hook PostToolUse chamado como o SDK chama.
// A decisão do aviso (marcos, uma vez cada) é do acompanhamento e é testada em
// handoffTracking/; aqui o que importa é que a sessão a liga só na conversa de
// handoff, devolve `additionalContext` e nunca interrompe nada.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StartAgentOptions } from '../shared/ipc'
import type { BrowserController } from './browserController'

const cacheState = vi.hoisted(() => ({ dir: '', memoriesDir: '', skillsDir: '' }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ ...cacheState }) }))
vi.mock('./config', () => ({
  loadConfig: () => ({
    windowsControlEnabled: false,
    ollama: { enabled: false, apiKey: '' },
    board: { requirePlan: true }
  })
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

const queryMock = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@anthropic-ai/claude-agent-sdk')
  return {
    ...actual,
    query: (args: { options: unknown }) => {
      queryMock(args)
      return (async function* () {})()
    }
  }
})

import { AgentSession } from './agentSession'
import { setActiveHandoffTracker } from './handoffTracking/handoffRuntime'
import type { HandoffTracker } from './handoffTracking/handoffTracker'

const slug = 'checkout'
const AVISO = '⏱ Etapa 3 (prazos): 34 de 40 min de trabalho — 80% do prazo da etapa (tempo ativo medido pelo app).'
const OPAQUE = 'Trabalho autônomo sem prova de término.'
let root = ''
let cwd = ''
const sessions: AgentSession[] = []
const deadlineNotice = vi.fn<(convId: string) => Promise<string | null>>()

type Hook = (input: Record<string, unknown>) => Promise<unknown>

async function started(extra: Partial<StartAgentOptions> = {}): Promise<{ s: AgentSession; pre: Hook; post: Hook | undefined }> {
  const s = new AgentSession({ convId: 'c1', cwd, ...extra }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn())
  sessions.push(s)
  await s.start()
  const options = queryMock.mock.calls.at(-1)![0].options as { hooks?: Record<string, Array<{ hooks: Hook[] }>> }
  return { s, pre: options.hooks!.PreToolUse[0].hooks[0], post: options.hooks?.PostToolUse?.[0]?.hooks[0] }
}

const call = (id: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_use_id: id, tool_input: {}, ...extra })
const done = (id: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'PostToolUse',
  ...call(id, extra),
  tool_response: {}
})

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-prazo-'))
  cwd = path.join(root, 'projeto')
  cacheState.dir = path.join(root, 'cache')
  cacheState.memoriesDir = path.join(root, 'cache', 'memories')
  cacheState.skillsDir = path.join(root, 'cache', 'skills')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

beforeEach(() => {
  queryMock.mockClear()
  deadlineNotice.mockReset()
  deadlineNotice.mockResolvedValue(AVISO)
  setActiveHandoffTracker({ deadlineNotice } as unknown as HandoffTracker)
})

afterEach(() => {
  setActiveHandoffTracker(null)
  for (const s of sessions.splice(0)) s.dispose()
})

describe('AgentSession — aviso de prazo no PostToolUse', () => {
  it('conversa de handoff: devolve o aviso como additionalContext, sem mais nada (nada de parar o agente)', async () => {
    const { s, pre, post } = await started({ handoff: { slug } })
    const interrupt = vi.spyOn(s, 'interrupt')
    await pre({ hook_event_name: 'PreToolUse', ...call('t1') })
    expect(s.restartActivity().unsafe).toBe(OPAQUE)

    const out = await post!(done('t1'))
    // Exatamente isto: sem `continue: false`, `decision`, `stopReason`.
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: AVISO } })
    expect(deadlineNotice).toHaveBeenCalledWith('c1')
    // O que o hook já fazia continua: a chamada saiu do voo.
    expect(s.restartActivity().unsafe).not.toBe(OPAQUE)
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('fora dos marcos o acompanhamento devolve null e o hook devolve {} como sempre', async () => {
    deadlineNotice.mockResolvedValue(null)
    const { post } = await started({ handoff: { slug } })
    await expect(post!(done('t1'))).resolves.toEqual({})
    expect(deadlineNotice).toHaveBeenCalledTimes(1)
  })

  it('conversa comum: {} e o acompanhamento nem é consultado', async () => {
    const { s, pre, post } = await started()
    await pre({ hook_event_name: 'PreToolUse', ...call('t1') })
    await expect(post!(done('t1'))).resolves.toEqual({})
    expect(deadlineNotice).not.toHaveBeenCalled()
    expect(s.restartActivity().unsafe).not.toBe(OPAQUE)
  })

  it('Agent Manager (planning, mesmo com handoff): nunca consulta', async () => {
    const { post } = await started({ planning: { slug }, handoff: { slug } })
    if (post) await expect(post(done('t1'))).resolves.toEqual({})
    expect(deadlineNotice).not.toHaveBeenCalled()
  })

  it('ferramenta de subagente: {} — o aviso fica para o agente principal', async () => {
    const { post } = await started({ handoff: { slug } })
    await expect(post!(done('t1', { agent_id: 'sub-1', agent_type: 'general-purpose' }))).resolves.toEqual({})
    expect(deadlineNotice).not.toHaveBeenCalled()
    await expect(post!(done('t2'))).resolves.toMatchObject({ hookSpecificOutput: { additionalContext: AVISO } })
  })

  it('acompanhamento falhando ou desligado: {} sem lançar, e a chamada sai do voo', async () => {
    deadlineNotice.mockRejectedValue(new Error('banco fora do ar'))
    const { s, pre, post } = await started({ handoff: { slug } })
    await pre({ hook_event_name: 'PreToolUse', ...call('t1') })
    await expect(post!(done('t1'))).resolves.toEqual({})
    expect(s.restartActivity().unsafe).not.toBe(OPAQUE)
    setActiveHandoffTracker(null)
    await expect(post!(done('t2'))).resolves.toEqual({})
  })
})
