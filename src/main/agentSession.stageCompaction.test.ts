// @vitest-environment node
// A compactação no fim da etapa na AgentSession REAL: start() montando as Options
// do SDK (`query` é dublê) e os hooks PreCompact/PostToolUse chamados como o SDK
// chama. A regra fina (prefixo, teto) está em agents/stageCompaction.test.ts.
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

let root = ''
let cwd = ''
const sessions: AgentSession[] = []

type Hook = (input: Record<string, unknown>) => Promise<unknown>
type Started = { s: AgentSession; emit: ReturnType<typeof vi.fn>; pre: Hook | undefined; post: Hook }

async function started(extra: Partial<StartAgentOptions> = {}): Promise<Started> {
  const emit = vi.fn()
  const s = new AgentSession({ convId: 'c1', cwd, model: 'claude-opus-5-5', ...extra }, {} as BrowserController, emit, vi.fn(), vi.fn())
  sessions.push(s)
  await s.start()
  const options = queryMock.mock.calls.at(-1)![0].options as { hooks?: Record<string, Array<{ hooks: Hook[] }>> }
  return { s, emit, pre: options.hooks?.PreCompact?.[0]?.hooks[0], post: options.hooks!.PostToolUse[0].hooks[0] }
}

const setContext = (s: AgentSession, tokens: number): void => {
  (s as unknown as { lastContextTokens: number }).lastContextTokens = tokens
}
const handle = (s: AgentSession, message: unknown): void =>
  (s as unknown as { handleMessage(m: unknown): void }).handleMessage(message)
const compact = (trigger: 'auto' | 'manual') => ({ hook_event_name: 'PreCompact', trigger, custom_instructions: null })
let seq = 0
const tool = (tool_name: string, tool_input: unknown, tool_response: unknown = {}, extra: Record<string, unknown> = {}) =>
  ({ hook_event_name: 'PostToolUse', tool_name, tool_use_id: `t${++seq}`, tool_input, tool_response, ...extra })
const BLOCK = { decision: 'block', reason: 'Etapa do handoff em andamento: compacta ao fechá-la.' }

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-compacta-'))
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
})

afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
})

describe('AgentSession — compactação no fim da etapa (PreCompact)', () => {
  it('handoff no meio da etapa: segura a automática e avisa na tela uma vez', async () => {
    const { s, emit, pre } = await started({ handoff: { slug: 'x' } })
    setContext(s, 250_000)
    await expect(pre!(compact('auto'))).resolves.toEqual(BLOCK)
    await expect(pre!(compact('auto'))).resolves.toEqual(BLOCK)
    const avisos = emit.mock.calls.filter(([e]) => e.kind === 'status' && /Compactação adiada/.test(e.text))
    expect(avisos).toHaveLength(1)
  })

  it('etapa [id] fechada no TaskUpdate: a próxima automática passa; depois de compactar volta a esperar', async () => {
    const { s, pre, post } = await started({ handoff: { slug: 'x' } })
    setContext(s, 250_000)
    await post(tool('TaskCreate', { subject: '[pagamento] Checkout' }, { task: { id: '1', subject: '[pagamento] Checkout' } }))
    await post(tool('TaskCreate', { subject: 'rodar testes' }, { task: { id: '2', subject: 'rodar testes' } }))
    await post(tool('TaskUpdate', { taskId: '2', status: 'completed' }))
    await expect(pre!(compact('auto'))).resolves.toEqual(BLOCK)
    await post(tool('TaskUpdate', { taskId: '1', status: 'completed' }))
    await expect(pre!(compact('auto'))).resolves.toEqual({})
    handle(s, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 250_000, post_tokens: 9_000 } })
    await expect(pre!(compact('auto'))).resolves.toEqual(BLOCK)
  })

  it('etapa [id] concluída no TodoWrite fecha; item sem prefixo e conclusão repetida não', async () => {
    const { s, pre, post } = await started({ handoff: { slug: 'x' } })
    setContext(s, 250_000)
    const todos = (first: string, second: string) => ({ todos: [
      { content: '[leitura] Ler o fluxo', status: first, activeForm: 'Lendo' },
      { content: 'rodar testes', status: second, activeForm: 'Rodando' }
    ] })
    await post(tool('TodoWrite', todos('in_progress', 'completed')))
    await expect(pre!(compact('auto'))).resolves.toEqual(BLOCK)
    await post(tool('TodoWrite', todos('completed', 'completed')))
    await expect(pre!(compact('auto'))).resolves.toEqual({})
    handle(s, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } })
    await post(tool('TodoWrite', todos('completed', 'completed')))
    await expect(pre!(compact('auto'))).resolves.toEqual(BLOCK)
  })

  it('ferramenta de subagente não fecha etapa do agente principal', async () => {
    const { s, pre, post } = await started({ handoff: { slug: 'x' } })
    setContext(s, 250_000)
    await post(tool('TodoWrite', { todos: [{ content: '[a] A', status: 'completed' }] }, {}, { agent_id: 'sub-1' }))
    await expect(pre!(compact('auto'))).resolves.toEqual(BLOCK)
  })

  it('teto do modelo, contexto desconhecido e /compact manual: passa sempre', async () => {
    const { s, pre } = await started({ handoff: { slug: 'x' } })
    setContext(s, 400_000)
    await expect(pre!(compact('auto'))).resolves.toEqual({})
    setContext(s, 0)
    await expect(pre!(compact('auto'))).resolves.toEqual({})
    setContext(s, 250_000)
    await expect(pre!(compact('manual'))).resolves.toEqual({})
  })

  it('modelo de 200k (sem folga acima da janela): nunca segura', async () => {
    // Fora de CONTEXT_LIMITS: cai no limite padrão de 200k.
    const { s, pre } = await started({ handoff: { slug: 'x' }, model: 'claude-modelo-sem-tabela' })
    setContext(s, 150_000)
    if (pre) await expect(pre(compact('auto'))).resolves.toEqual({})
  })

  it('conversa comum e Agent Manager: nunca seguram', async () => {
    for (const extra of [{}, { planning: { slug: 'x' }, handoff: { slug: 'x' } }] as Array<Partial<StartAgentOptions>>) {
      const { s, pre } = await started(extra)
      setContext(s, 250_000)
      if (pre) await expect(pre(compact('auto'))).resolves.toEqual({})
    }
  })
})
