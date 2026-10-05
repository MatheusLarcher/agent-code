// @vitest-environment node
// A ligação do servidor `entregas` na AgentSession REAL: start() montando as
// Options do SDK (sem subir o SDK — `query` é dublê) e o gate de permissão. A
// regra em si (entregaServerApplies) é testada em entregaTools.test.ts; aqui o
// que importa é que a sessão a aplica.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StartAgentOptions } from '../../shared/ipc'
import type { BrowserController } from '../browserController'

const cacheState = vi.hoisted(() => ({ dir: '', memoriesDir: '', skillsDir: '' }))
vi.mock('../store', () => ({ getCacheInfo: () => ({ ...cacheState }) }))
vi.mock('../config', () => ({
  loadConfig: () => ({
    windowsControlEnabled: false,
    ollama: { enabled: false, apiKey: '' },
    board: { requirePlan: true }
  })
}))
vi.mock('../codexAuth', () => ({ isCodexConnected: () => true }))
vi.mock('../codexProxy', () => ({ ensureCodexProxyRunning: vi.fn(), FAST_MODE_TOKEN_SUFFIX: '+fast' }))
vi.mock('../persistence/lifecycle', () => ({
  storageLifecycle: { repository: () => ({ countConversationsByProject: async () => [] }) }
}))
vi.mock('../projectOutline', () => ({ buildProjectOutline: async () => '' }))
vi.mock('../typesafe', () => ({
  typeSafeMemorySelectionActive: async () => false,
  selectMemoriesWithTypeSafe: async () => null
}))
vi.mock('../memory/memoryRuntime', () => ({
  memoryService: () => ({}),
  secretSink: () => null,
  secretVaultEnabled: () => false,
  readSecret: async () => null,
  readSecretsForPrompt: async () => []
}))
vi.mock('../tasks/taskRuntime', () => ({ taskLedger: () => ({}) }))

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

import { AgentSession } from '../agentSession'
import { ENTREGA_ESTIMAR_TOOL, ENTREGA_TEMPO_TOOL } from './entregaTools'

const slug = 'checkout'
let root = ''
let cwd = ''
const sessions: AgentSession[] = []

function makeSession(extra: Partial<StartAgentOptions> = {}, ask = vi.fn()): AgentSession {
  const s = new AgentSession({ convId: 'c1', cwd, ...extra }, {} as BrowserController, vi.fn(), ask, vi.fn())
  sessions.push(s)
  return s
}

type Gate = (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>
const gate = (s: AgentSession): Gate => (name, input) =>
  (s as unknown as { handlePermission: Gate }).handlePermission(name, input)
type Servers = Record<string, { name?: string; instance?: { _registeredTools?: object } }>
const lastServers = (): Servers =>
  (queryMock.mock.calls.at(-1)?.[0] as { options: { mcpServers: Servers } }).options.mcpServers

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-entregas-'))
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

describe('AgentSession — servidor MCP `entregas`', () => {
  it('a conversa de handoff sobe com o servidor e as duas ferramentas, junto dos de sempre', async () => {
    await makeSession({ handoff: { slug } }).start()
    const servers = lastServers()
    expect(Object.keys(servers)).toEqual(expect.arrayContaining(['entregas', 'browser', 'tasks', 'memory']))
    expect(servers.entregas.name).toBe('entregas')
    expect(Object.keys(servers.entregas.instance?._registeredTools ?? {}).sort()).toEqual(['entrega_estimar', 'entrega_tempo'])
  })

  it('a conversa comum e a do Agent Manager não têm o servidor', async () => {
    await makeSession().start()
    expect(Object.keys(lastServers())).not.toContain('entregas')
    await makeSession({ planning: { slug } }).start()
    expect(Object.keys(lastServers())).not.toContain('entregas')
  })

  it('na conversa de handoff as entrega_* passam sem pedir permissão (sem "Permitir tudo")', async () => {
    const ask = vi.fn()
    const g = gate(makeSession({ handoff: { slug } }, ask))
    for (const tool of [ENTREGA_ESTIMAR_TOOL, ENTREGA_TEMPO_TOOL]) {
      const input = { etapa: 'etapa-a', minutos: 10, motivo: 'm' }
      expect(await g(tool, input)).toEqual({ behavior: 'allow', updatedInput: input })
    }
    expect(ask).not.toHaveBeenCalled()
  })

  it('numa conversa comum, uma ferramenta com o mesmo nome vai ao pedido de permissão', async () => {
    const ask = vi.fn()
    const s = makeSession({}, ask)
    void gate(s)(ENTREGA_ESTIMAR_TOOL, { etapa: 'x' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatchObject({ toolName: ENTREGA_ESTIMAR_TOOL })
  })
})
