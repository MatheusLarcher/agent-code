// @vitest-environment node
// A ligação do planejamento na AgentSession REAL: start() montando as Options
// do SDK e o gate de permissão com "Permitir tudo" ligado. A política em si
// (globs, skills) é testada em planning/planningPolicy.test.ts; aqui o que
// importa é que a sessão a aplica, e ANTES do bypassAll.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { StartAgentOptions } from '../shared/ipc'
import type { BrowserController } from './browserController'
import { PLAN_GATE_MESSAGE } from './board/planGate'

const cacheState = vi.hoisted(() => ({ dir: '', memoriesDir: '', skillsDir: '' }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ ...cacheState }) }))
vi.mock('./config', () => ({
  loadConfig: () => ({
    windowsControlEnabled: false,
    ollama: { enabled: false, apiKey: '' },
    // A trava do plano LIGADA: é o que prova que o Manager a desliga.
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
// Serviço de memória e registro de tarefas NO AR: sem eles, "o Manager não
// tem `tasks` e mantém `memory`" seria verdade por vacuidade.
vi.mock('./memory/memoryRuntime', () => ({
  memoryService: () => ({}),
  secretSink: () => null,
  secretVaultEnabled: () => false,
  readSecret: async () => null,
  readSecretsForPrompt: async () => []
}))
vi.mock('./tasks/taskRuntime', () => ({ taskLedger: () => ({}) }))

// Captura as Options entregues ao SDK. `sdkStream.fail` faz o stream quebrar
// (o caminho de erro que também encerra o turno).
const queryMock = vi.hoisted(() => vi.fn())
const sdkStream = vi.hoisted(() => ({ fail: false }))
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@anthropic-ai/claude-agent-sdk')
  return {
    ...actual,
    query: (args: { options: unknown }) => {
      queryMock(args)
      return (async function* () {
        if (sdkStream.fail) throw new Error('stream caiu')
      })()
    }
  }
})

import { AgentSession } from './agentSession'

const slug = 'checkout'
let root = ''
let cwd = ''
const at = (...parts: string[]): string => path.join(cwd, ...parts)
const sessions: AgentSession[] = []

function makeSession(extra: Partial<StartAgentOptions> = {}): AgentSession {
  const s = new AgentSession({ convId: 'c1', cwd, ...extra }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn())
  sessions.push(s)
  return s
}

type Gate = (name: string, input: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>
const gate = (s: AgentSession): Gate => (name, input) =>
  (s as unknown as { handlePermission: Gate }).handlePermission(name, input)
const beginTurn = (s: AgentSession): void => (s as unknown as { beginTurn(): void }).beginTurn()
const handle = (s: AgentSession, message: unknown): void =>
  (s as unknown as { handleMessage(m: unknown): void }).handleMessage(message)
const lastOptions = (): Record<string, unknown> =>
  (queryMock.mock.calls.at(-1)?.[0] as { options: Record<string, unknown> }).options

/** "Permitir tudo" ligado e um turno aberto (a trava do plano só age em turno). */
function armed(extra: Partial<StartAgentOptions>): Gate {
  const s = makeSession(extra)
  s.setBypass(true)
  beginTurn(s)
  return gate(s)
}

const RESULT = { type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1 }

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-planning-'))
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
  sdkStream.fail = false
})

afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
})

describe('AgentSession — start() da sessão do Agent Manager', () => {
  it('servidores MCP: planning + memory; sem browser, android, app, windows e tasks', async () => {
    await makeSession({ planning: { slug } }).start()
    const servers = Object.keys(lastOptions().mcpServers as object)
    expect(servers).toContain('planning')
    expect(servers).toContain('memory')
    for (const name of ['browser', 'android', 'app', 'windows', 'tasks']) expect(servers).not.toContain(name)
  })

  it('prompt do Manager + memória, sem os hints de browser/android/tasks/windows', async () => {
    await makeSession({ planning: { slug } }).start()
    const { append } = lastOptions().systemPrompt as { append: string }
    expect(append).toContain(`Agent Manager do planejamento "${slug}"`)
    expect(append).toContain(path.join(cwd, 'docs', 'spec', slug, '_sandbox'))
    expect(append).toContain('PERSISTENT MEMORY')
    expect(append).not.toContain('embedded web browser')
    expect(append).not.toContain('TASK LEDGER')
    expect(append).not.toContain('"android" MCP tools')
    expect(append).not.toContain('Controle de aplicativos do Windows')
  })

  it('sem subagentes nem outros shells; strictMcpConfig; nenhum agente especialista', async () => {
    await makeSession({ planning: { slug } }).start()
    const options = lastOptions()
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining(['Agent', 'Task', 'NotebookEdit', 'Monitor', 'PowerShell', 'Workflow', 'EnterWorktree', 'CronCreate', 'RemoteTrigger'])
    )
    expect(options.strictMcpConfig).toBe(true)
    expect(options.agents).toBeUndefined()
  })

  it('regressão: sessão comum sobe exatamente como antes', async () => {
    await makeSession().start()
    const options = lastOptions()
    const servers = Object.keys(options.mcpServers as object)
    expect(servers).toEqual(expect.arrayContaining(['browser', 'android', 'memory', 'tasks']))
    expect(servers).not.toContain('planning')
    expect(options.disallowedTools).toBeUndefined()
    expect(options.strictMcpConfig).toBeUndefined()
    expect(Object.keys(options.agents as object).length).toBeGreaterThan(0)
    const { append } = options.systemPrompt as { append: string }
    expect(append).toContain('embedded web browser')
    expect(append).toContain('TASK LEDGER')
    expect(append).not.toContain('Agent Manager')
  })
})

describe('AgentSession — gate do Agent Manager com "Permitir tudo" ligado', () => {
  it('Write em src/x.ts é negado pelo escopo', async () => {
    const res = await armed({ planning: { slug } })('Write', { file_path: at('src', 'x.ts'), content: 'x' })
    expect(res.behavior).toBe('deny')
    expect(res.message).toMatch(/recusado pelo escopo/)
  })

  it('Write em docs/spec/<slug>/_sandbox/a.ts passa, sem a recusa da trava do plano', async () => {
    const input = { file_path: at('docs', 'spec', slug, '_sandbox', 'a.ts'), content: 'x' }
    const res = await armed({ planning: { slug } })('Write', input)
    expect(res).toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('controle: numa sessão comum, a mesma escrita em turno leva a recusa da trava do plano', async () => {
    const res = await armed({})('Write', { file_path: at('docs', 'spec', slug, '_sandbox', 'a.ts'), content: 'x' })
    expect(res).toEqual({ behavior: 'deny', message: PLAN_GATE_MESSAGE })
  })

  it('Write em docs/spec/<slug>/cards/x.md é negado (cards só mudam por plan_*)', async () => {
    const res = await armed({ planning: { slug } })('Write', { file_path: at('docs', 'spec', slug, 'cards', 'x.md'), content: 'x' })
    expect(res.behavior).toBe('deny')
    expect(res.message).toMatch(/não casa o allow/)
  })

  it('Bash `echo x > src/a.ts` é negado', async () => {
    const res = await armed({ planning: { slug } })('Bash', { command: 'echo x > src/a.ts' })
    expect(res.behavior).toBe('deny')
    expect(res.message).toMatch(/Bash recusado/)
  })

  it('fora da allowlist (Monitor, PowerShell, mcp__powerbi__x, EnterWorktree) é negado; numa sessão comum, não', async () => {
    const g = armed({ planning: { slug } })
    for (const tool of ['Monitor', 'PowerShell', 'mcp__powerbi__x', 'EnterWorktree', 'ScheduleWakeup']) {
      const res = await g(tool, { command: 'x' })
      expect(res.behavior, tool).toBe('deny')
      expect(res.message).toMatch(/não está disponível na sessão do Agent Manager/)
    }
    expect((await armed({})('Monitor', { command: 'x' })).behavior).toBe('allow')
  })

  it('Skill planejar é negada; outra skill segue o "Permitir tudo"', async () => {
    const g = armed({ planning: { slug } })
    const denied = await g('Skill', { skill: 'planejar' })
    expect(denied.behavior).toBe('deny')
    expect(denied.message).toMatch(/não roda na sessão do Agent Manager/)
    expect((await g('Skill', { skill: 'code-review' })).behavior).toBe('allow')
  })
})

describe('AgentSession — Bash do Agent Manager pede aprovação, salvo "Permitir tudo"', () => {
  /** Sessão com o `askPermission` observável: é por ele que o pedido chega ao usuário. */
  function withAsk(extra: Partial<StartAgentOptions>): { s: AgentSession; ask: ReturnType<typeof vi.fn>; g: Gate } {
    const ask = vi.fn()
    const s = new AgentSession({ convId: 'c1', cwd, ...extra }, {} as BrowserController, vi.fn(), ask, vi.fn())
    sessions.push(s)
    return { s, ask, g: gate(s) }
  }
  const lastAskId = (ask: ReturnType<typeof vi.fn>): string => (ask.mock.calls.at(-1)?.[0] as { id: string }).id

  it('com "Permitir tudo" ligado, Bash `git status` no Manager passa sem perguntar', async () => {
    const { s, ask, g } = withAsk({ planning: { slug } })
    s.setBypass(true)
    beginTurn(s)
    const input = { command: 'git status' }
    expect(await g('Bash', input)).toEqual({ behavior: 'allow', updatedInput: input })
    expect(ask).not.toHaveBeenCalled()
  })

  it('sem "Permitir tudo", Bash `git status` no Manager vai ao pedido de permissão', async () => {
    const { s, ask, g } = withAsk({ planning: { slug } })
    beginTurn(s)
    const input = { command: 'git status' }

    let settled = false
    const pending = g('Bash', input).finally(() => {
      settled = true
    })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatchObject({ toolName: 'Bash', input })
    await Promise.resolve()
    expect(settled).toBe(false)

    s.resolvePermission({ id: lastAskId(ask), behavior: 'allow' })
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('"sempre permitir" não vale para o Bash do Manager: a próxima chamada pergunta de novo', async () => {
    const { s, ask, g } = withAsk({ planning: { slug } })
    const first = g('Bash', { command: 'git status' })
    s.resolvePermission({ id: lastAskId(ask), behavior: 'allow', always: true })
    expect((await first).behavior).toBe('allow')

    const second = g('Bash', { command: 'git log --oneline -5' })
    expect(ask).toHaveBeenCalledTimes(2)
    s.resolvePermission({ id: lastAskId(ask), behavior: 'deny', message: 'não' })
    expect(await second).toEqual({ behavior: 'deny', message: 'não' })
  })

  it('ligar "Permitir tudo" com um Bash do Manager pendente o aprova', async () => {
    const { s, g } = withAsk({ planning: { slug } })
    const input = { command: 'git status' }
    const pending = g('Bash', input)
    s.setBypass(true)
    expect(await pending).toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('Bash que escreve fora do _sandbox continua negado sem perguntar', async () => {
    const { s, ask, g } = withAsk({ planning: { slug } })
    s.setBypass(true)
    const res = await g('Bash', { command: 'echo x > src/a.ts' })
    expect(res.behavior).toBe('deny')
    expect(res.message).toMatch(/Bash recusado/)
    expect(ask).not.toHaveBeenCalled()
  })

  it('no Manager, o resto segue o "Permitir tudo" (Read, Write no _sandbox)', async () => {
    const { s, ask, g } = withAsk({ planning: { slug } })
    s.setBypass(true)
    beginTurn(s)
    expect((await g('Read', { file_path: at('src', 'x.ts') })).behavior).toBe('allow')
    const input = { file_path: at('docs', 'spec', slug, '_sandbox', 'a.ts'), content: 'x' }
    expect(await g('Write', input)).toEqual({ behavior: 'allow', updatedInput: input })
    expect(ask).not.toHaveBeenCalled()
  })

  it('regressão: numa sessão comum com "Permitir tudo", Bash `git status` segue auto-aprovado', async () => {
    const { s, ask, g } = withAsk({})
    s.setBypass(true)
    const input = { command: 'git status' }
    expect(await g('Bash', input)).toEqual({ behavior: 'allow', updatedInput: input })
    expect(ask).not.toHaveBeenCalled()
  })

  it('regressão: numa sessão comum, "sempre permitir" do Bash continua valendo', async () => {
    const { s, ask, g } = withAsk({})
    const first = g('Bash', { command: 'git status' })
    s.resolvePermission({ id: lastAskId(ask), behavior: 'allow', always: true })
    expect((await first).behavior).toBe('allow')
    expect((await g('Bash', { command: 'git log' })).behavior).toBe('allow')
    expect(ask).toHaveBeenCalledTimes(1)
  })
})

describe('AgentSession — conversa de handoff', () => {
  it('Skill planejar negada antes do fim do 1º turno e liberada depois do result', async () => {
    const s = makeSession({ handoff: { slug } })
    s.setBypass(true)
    beginTurn(s)
    const g = gate(s)
    const before = await g('Skill', { skill: 'planejar' })
    expect(before.behavior).toBe('deny')
    expect(before.message).toMatch(/primeiro turno desta conversa de handoff/)
    // O `result` de um subagente em background não é o fim do turno principal.
    handle(s, { ...RESULT, origin: { kind: 'peer' } })
    expect((await g('Skill', { skill: 'planejar' })).behavior).toBe('deny')

    handle(s, RESULT)
    expect(await g('Skill', { skill: 'planejar' })).toEqual({ behavior: 'allow', updatedInput: { skill: 'planejar' } })
  })

  it('handoff retomado (resume) já passou do 1º turno: nada é recusado', async () => {
    const s = makeSession({ handoff: { slug }, resume: 'sessao-anterior' })
    s.setBypass(true)
    expect(await gate(s)('Skill', { skill: 'planejar' })).toEqual({ behavior: 'allow', updatedInput: { skill: 'planejar' } })
  })

  it('o erro que encerra o 1º turno também libera', async () => {
    sdkStream.fail = true
    // "Permitir tudo" pela opção de início: start() relê o toggle dela.
    const s = makeSession({ handoff: { slug }, skipPermissions: true })
    await s.start()
    await vi.waitFor(async () => expect((await gate(s)('Skill', { skill: 'planejar' })).behavior).toBe('allow'))
  })

  it('não recebe o escopo do Manager nem desliga a trava do plano', async () => {
    const g = armed({ handoff: { slug } })
    const res = await g('Write', { file_path: at('src', 'x.ts'), content: 'x' })
    expect(res).toEqual({ behavior: 'deny', message: PLAN_GATE_MESSAGE })
  })
})

describe('AgentSession — ferramentas plan_* sem "Permitir tudo"', () => {
  it('no Agent Manager as plan_* passam sem pedir permissão', async () => {
    const s = makeSession({ planning: { slug } })
    const input = { tipo: 'nota', titulo: 'x', corpo: '' }
    expect(await gate(s)('mcp__planning__plan_card_create', input)).toEqual({ behavior: 'allow', updatedInput: input })
  })
})

describe('AgentSession — bloco do handoff no system prompt', () => {
  const appendOf = (): string => (lastOptions().systemPrompt as { append: string }).append
  const HANDOFF_HEADING = `## Conversa de implementação — handoff do planejamento "${slug}"`

  it('a conversa de handoff recebe o bloco, junto dos hints de sempre', async () => {
    await makeSession({ handoff: { slug } }).start()
    const append = appendOf()
    expect(append).toContain(HANDOFF_HEADING)
    expect(append).toContain(path.join(cwd, 'docs', 'spec', slug))
    expect(append).toContain('Não replaneje')
    // Os hints da sessão comum continuam lá.
    expect(append).toContain('embedded web browser')
    expect(append).toContain('TASK LEDGER')
    expect(append).toContain('PERSISTENT MEMORY')
  })

  it('regressão: sessão comum e sessão do Manager não recebem o bloco', async () => {
    await makeSession().start()
    expect(appendOf()).not.toContain('Conversa de implementação')
    await makeSession({ planning: { slug } }).start()
    expect(appendOf()).not.toContain('Conversa de implementação')
    expect(appendOf()).toContain(`Agent Manager do planejamento "${slug}"`)
  })
})

describe('AgentSession — hook PreToolUse do Agent Manager', () => {
  type HookOut = {
    hookSpecificOutput?: { hookEventName: string; permissionDecision?: string; permissionDecisionReason?: string }
  }
  type PreToolHook = (input: Record<string, unknown>, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<HookOut>
  type InFlight = { toolsInFlight: Set<string>; restartOpaqueCalls: Set<string> }

  /** Sobe a sessão e devolve o PreToolUse que ela entregou ao SDK. */
  async function started(extra: Partial<StartAgentOptions>): Promise<{ s: AgentSession; run: (tool: string, input: unknown, id: string) => Promise<HookOut> }> {
    const s = makeSession(extra)
    await s.start()
    const hooks = lastOptions().hooks as { PreToolUse: Array<{ hooks: PreToolHook[] }> }
    const hook = hooks.PreToolUse[0].hooks[0]
    const run = (tool: string, input: unknown, id: string): Promise<HookOut> =>
      hook(
        { hook_event_name: 'PreToolUse', session_id: 's', transcript_path: '', cwd, tool_name: tool, tool_input: input, tool_use_id: id },
        id,
        { signal: new AbortController().signal }
      )
    return { s, run }
  }
  const inFlight = (s: AgentSession): InFlight => s as unknown as InFlight

  it('Manager: Write em src/x.ts → deny, e o tool_use_id não fica em voo', async () => {
    const { s, run } = await started({ planning: { slug } })
    const out = await run('Write', { file_path: at('src', 'x.ts'), content: 'x' }, 'tu-write')
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/recusado pelo escopo/)
    // Negada no PreToolUse, a ferramenta não roda e o SDK não manda Post*: nada preso.
    expect(inFlight(s).toolsInFlight.has('tu-write')).toBe(false)
    expect(inFlight(s).restartOpaqueCalls.has('tu-write')).toBe(false)
  })

  it('Manager: Bash `echo x > src/a.ts` → deny, sem registro de chamada opaca', async () => {
    const { s, run } = await started({ planning: { slug } })
    const out = await run('Bash', { command: 'echo x > src/a.ts' }, 'tu-echo')
    expect(out.hookSpecificOutput?.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/Bash recusado/)
    expect(inFlight(s).restartOpaqueCalls.size).toBe(0)
    expect(inFlight(s).toolsInFlight.size).toBe(0)
  })

  it('Manager: Bash `git status` → ask, e segue registrado em voo (pode rodar)', async () => {
    const { s, run } = await started({ planning: { slug } })
    const out = await run('Bash', { command: 'git status' }, 'tu-git')
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'ask' })
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBeTruthy()
    expect(inFlight(s).toolsInFlight.has('tu-git')).toBe(true)
    expect(inFlight(s).restartOpaqueCalls.has('tu-git')).toBe(true)
  })

  it('Manager: Read → {} (o hook não opina)', async () => {
    const { s, run } = await started({ planning: { slug } })
    expect(await run('Read', { file_path: at('src', 'x.ts') }, 'tu-read')).toEqual({})
    expect(inFlight(s).toolsInFlight.has('tu-read')).toBe(true)
  })

  it('Manager: fora da allowlist → deny sem registro em voo; Read/WebSearch/plan_read/ToolSearch → {}', async () => {
    const { s, run } = await started({ planning: { slug } })
    for (const tool of ['Monitor', 'PowerShell', 'mcp__powerbi__x', 'EnterWorktree']) {
      const out = await run(tool, { command: 'x' }, `tu-${tool}`)
      expect(out.hookSpecificOutput?.permissionDecision, tool).toBe('deny')
      expect(out.hookSpecificOutput?.permissionDecisionReason).toMatch(/não está disponível na sessão do Agent Manager/)
    }
    expect(inFlight(s).toolsInFlight.size).toBe(0)
    expect(inFlight(s).restartOpaqueCalls.size).toBe(0)
    for (const tool of ['Read', 'WebSearch', 'mcp__planning__plan_read', 'ToolSearch']) {
      expect(await run(tool, { query: 'x' }, `ok-${tool}`), tool).toEqual({})
    }
    // Regressão: numa sessão comum, as mesmas ferramentas o hook não opina.
    const comum = await started({})
    for (const tool of ['Monitor', 'PowerShell', 'mcp__powerbi__x']) expect(await comum.run(tool, {}, `c-${tool}`), tool).toEqual({})
  })

  it('Manager: Write no _sandbox → {}', async () => {
    const { run } = await started({ planning: { slug } })
    expect(await run('Write', { file_path: at('docs', 'spec', slug, '_sandbox', 'a.ts'), content: 'x' }, 'tu-sb')).toEqual({})
  })

  it('regressão: sessão comum, Write em src/x.ts e Bash → {} e registrados em voo', async () => {
    const { s, run } = await started({})
    expect(await run('Write', { file_path: at('src', 'x.ts'), content: 'x' }, 'tu-w')).toEqual({})
    expect(await run('Bash', { command: 'git status' }, 'tu-b')).toEqual({})
    expect(inFlight(s).toolsInFlight.has('tu-w')).toBe(true)
    expect(inFlight(s).restartOpaqueCalls.has('tu-b')).toBe(true)
  })

  it('regressão: conversa de handoff, Write em src/x.ts → {}', async () => {
    const { run } = await started({ handoff: { slug } })
    expect(await run('Write', { file_path: at('src', 'x.ts'), content: 'x' }, 'tu-h')).toEqual({})
  })
})

describe('AgentSession — regressão da sessão comum', () => {
  it('Skill planejar liberada e Write em src/x.ts sem recusa de escopo', async () => {
    const s = makeSession()
    s.setBypass(true)
    const g = gate(s)
    expect(await g('Skill', { skill: 'planejar' })).toEqual({ behavior: 'allow', updatedInput: { skill: 'planejar' } })
    const input = { file_path: at('src', 'x.ts'), content: 'x' }
    expect(await g('Write', input)).toEqual({ behavior: 'allow', updatedInput: input })
  })
})
