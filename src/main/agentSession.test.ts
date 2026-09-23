// @vitest-environment node
// Main-process code: pulls in node builtins (via config → store → node:sqlite),
// so it must run in the node env, not the default jsdom (which can't externalize
// the newer node:sqlite builtin and tries to bundle it).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { STALL_THRESHOLD_MS, STALL_THRESHOLD_TOOL_MS } from './stallWatch'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const configState = vi.hoisted(() => ({
  windowsControlEnabled: false as unknown,
  ollama: { enabled: false, apiKey: '' }
}))
const codexState = vi.hoisted(() => ({ connected: true }))
const cacheState = vi.hoisted(() => ({
  dir: 'C:\\test\\agent-code',
  memoriesDir: 'C:\\test\\agent-code\\memories',
  skillsDir: 'C:\\test\\agent-code\\skills',
  localDir: 'C:\\test\\agent-code-local'
}))
const ensureCodexProxyMock = vi.hoisted(() =>
  vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:43210', secret: 'local-test-secret' }))
)
vi.mock('./config', () => ({
  loadConfig: () => ({
    windowsControlEnabled: configState.windowsControlEnabled,
    // start() reads these two; the permission-gate tests never call start(), but
    // the fast-mode test below does.
    ollama: configState.ollama
  })
}))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => codexState.connected }))
vi.mock('./codexProxy', () => ({
  ensureCodexProxyRunning: ensureCodexProxyMock,
  // Keep in sync with the real constant — agentSession appends it to the proxy
  // auth token to request fast mode for this conversation.
  FAST_MODE_TOKEN_SUFFIX: '+fast'
}))
vi.mock('./store', () => ({
  getCacheInfo: () => ({ ...cacheState })
}))
const projectsState = vi.hoisted(() => ({
  list: [] as { cwd: string; total: number; updatedAt: string }[]
}))
vi.mock('./persistence/lifecycle', () => ({
  storageLifecycle: {
    repository: () => ({
      countConversationsByProject: async () => projectsState.list
    })
  }
}))
const projectOutlineMock = vi.hoisted(() => vi.fn(async () => '[PROJECT_DOCS_CONTEXT]\ndocs/\n[/PROJECT_DOCS_CONTEXT]'))
vi.mock('./projectOutline', () => ({ buildProjectOutline: projectOutlineMock }))

// O seletor de memória do TypeSafe é exercitado por inteiro em
// typesafe/memorySelection.test.ts. Aqui só importa o CONTRATO com a sessão:
// quantas vezes ele roda e o que a decisão dele faz com o prompt.
const typeSafeState = vi.hoisted(() => ({
  active: false,
  /** `null` = não houve decisão (desligado, sem chave, timeout, erro). */
  selection: null as { block: string; relPaths: string[] } | null,
  queries: [] as string[],
  /** Liga o SELETOR DE VERDADE (só o serviço fica falso). É o que torna o teste
   *  do registro de memórias usadas uma integração, e não uma encenação. */
  passthrough: false,
  /**
   * Decisões EM VOO sob controle do teste: com a fila ligada, cada chamada
   * devolve uma promessa que só resolve quando o teste mandar, na ordem que o
   * teste quiser. É o que permite provocar a corrida do ordinal (turno N
   * resolvendo depois do turno N+1) sem depender de relógio — teste por tempo é
   * teste instável.
   */
  emVoo: null as null | Array<(selection: { block: string; relPaths: string[] } | null) => void>
}))
vi.mock('./typesafe', () => ({
  typeSafeMemorySelectionActive: async () => typeSafeState.active,
  selectMemoriesWithTypeSafe: async (dir: string, query: string) => {
    typeSafeState.queries.push(query)
    if (typeSafeState.emVoo) {
      const fila = typeSafeState.emVoo
      return new Promise<{ block: string; relPaths: string[] } | null>((resolve) => {
        fila.push(resolve)
      })
    }
    if (!typeSafeState.passthrough) return typeSafeState.selection
    // Import dinâmico: só este módulo, e só quando o teste pede o caminho real.
    const real = await import('./typesafe/memorySelection')
    return real.selectMemoriesWithTypeSafe(dir, query)
  }
}))

// O serviço do TypeSafe no modo passthrough: a decisão vem daqui, o resto do
// seletor (varredura da pasta, limiar, releitura do disco) roda de verdade.
const typeSafeService = vi.hoisted(() => ({ probabilities: null as Record<string, number> | null }))
vi.mock('./typesafe/client', () => ({
  typeSafeEnabled: () => true,
  typeSafeApiKey: async () => 'chave-de-teste',
  typeSafeMinConfidence: () => 0.6,
  askTypeSafe: async () =>
    typeSafeService.probabilities === null ? null : { memoria: { probabilities: typeSafeService.probabilities } }
}))

// Captures the Options object start() hands to the SDK, and ends the stream at
// once so start() returns instead of waiting on a real agent.
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
import {
  AgentSession,
  DEFAULT_LOOP_LIMIT,
  ECONOMY_TURN_REMINDER,
  MAX_LOOP_LIMIT,
  OPENAI_MAX_TURNS,
  buildContextStamp,
  loopLimitFromPrompt
} from './agentSession'
import type { BrowserController } from './browserController'
import type { SkillRuntimePaths } from './agentSession'
// Os módulos REAIS do registro de memórias usadas e do gate: nada aqui é
// injetado na sessão, é o mesmo caminho que `index.ts` liga em produção.
import { forgetUsedMemories, usedMemories } from './memoria/memoriasUsadas'
import { buildMemoryGateState } from './typesafe/memoryGate'

const secretsForPrompt = vi.hoisted(() => vi.fn(async () => [] as Array<{ name: string; value: string }>))
vi.mock('./memory/memoryRuntime', async () => {
  const actual = await vi.importActual<typeof import('./memory/memoryRuntime')>('./memory/memoryRuntime')
  return { ...actual, readSecretsForPrompt: () => secretsForPrompt() }
})

const describeImagesMock = vi.fn()
vi.mock('./visionRelay', async () => {
  const actual = await vi.importActual<typeof import('./visionRelay')>('./visionRelay')
  return { ...actual, describeImages: (...args: unknown[]) => describeImagesMock(...args) }
})

/** Peeks the raw SDK user-messages the session queued for the SDK to pull
 *  (AsyncQueue.values is private, but this is plain JS at runtime). */
function pushedMessages(s: AgentSession): Array<{ message: { content: unknown }; uuid?: string }> {
  return (s as unknown as { input: { values: Array<{ message: { content: unknown }; uuid?: string }> } }).input.values
}

// Build a session without starting the SDK query loop — we only exercise the
// permission gate (handlePermission / resolvePermission / setBypass).
function makeSession(opts: {
  skipPermissions?: boolean
  model?: string
  fastMode?: boolean
  effort?: string
  cwd?: string
  economyMode?: boolean
  loopEnabled?: boolean
  skillRuntime?: SkillRuntimePaths
  tokenUsageRepository?: { insertLlmCall: ReturnType<typeof vi.fn>; updateLlmCall?: ReturnType<typeof vi.fn> }
} = {}): {
  s: AgentSession
  emit: ReturnType<typeof vi.fn>
  ask: ReturnType<typeof vi.fn>
  expire: ReturnType<typeof vi.fn>
} {
  const emit = vi.fn()
  const ask = vi.fn()
  const expire = vi.fn()
  const browser = {} as BrowserController
  const { skillRuntime, tokenUsageRepository, ...agentOpts } = opts
  const s = new AgentSession(
    { convId: 'c1', cwd: '/proj', ...agentOpts },
    browser,
    emit,
    ask,
    expire,
    undefined,
    undefined,
    skillRuntime,
    undefined,
    tokenUsageRepository as never
  )
  return { s, emit, ask, expire }
}

// handlePermission is private; reach it directly for the test.
const gate = (s: AgentSession, name: string, input: Record<string, unknown>): Promise<unknown> =>
  (s as unknown as { handlePermission(n: string, i: Record<string, unknown>): Promise<unknown> }).handlePermission(
    name,
    input
  )

// handleMessage is private; reach it directly to drive a raw SDK message.
const handle = (s: AgentSession, message: unknown): void =>
  (s as unknown as { handleMessage(m: unknown): void }).handleMessage(message)

beforeEach(() => {
  configState.windowsControlEnabled = false
  configState.ollama = { enabled: false, apiKey: '' }
  codexState.connected = true
  cacheState.dir = 'C:\\test\\agent-code'
  cacheState.memoriesDir = 'C:\\test\\agent-code\\memories'
  cacheState.skillsDir = 'C:\\test\\agent-code\\skills'
  queryMock.mockClear()
  ensureCodexProxyMock.mockClear()
  projectOutlineMock.mockReset()
  projectOutlineMock.mockResolvedValue('[PROJECT_DOCS_CONTEXT]\ndocs/\n[/PROJECT_DOCS_CONTEXT]')
  typeSafeState.active = false
  typeSafeState.selection = null
  typeSafeState.queries = []
  typeSafeState.passthrough = false
  typeSafeState.emVoo = null
  typeSafeService.probabilities = null
  forgetUsedMemories('c1')
  projectsState.list = []
})

describe('AgentSession — fluxo de permissão', () => {
  it('auto-aprova ferramenta de leitura e DEVOLVE o input (updatedInput)', async () => {
    const { s, ask } = makeSession()
    const res = await gate(s, 'Read', { file_path: '/a.py' })
    expect(ask).not.toHaveBeenCalled()
    expect(res).toEqual({ behavior: 'allow', updatedInput: { file_path: '/a.py' } })
  })

  it('pede permissão no chat para ferramenta não-aprovada (ex.: Bash)', async () => {
    const { s, ask } = makeSession()
    void gate(s, 'Bash', { command: 'python x.py' })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toMatchObject({ toolName: 'Bash' })
  })

  it('ao permitir no modal, resolve com behavior allow + updatedInput (o input original)', async () => {
    const { s, ask } = makeSession()
    const input = { command: 'python x.py' }
    const p = gate(s, 'Bash', input)
    const { id } = ask.mock.calls[0][0]
    s.resolvePermission({ id, behavior: 'allow' })
    await expect(p).resolves.toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('ao negar, resolve com deny + mensagem', async () => {
    const { s, ask } = makeSession()
    const p = gate(s, 'Write', { file_path: '/f', content: 'x' })
    const { id } = ask.mock.calls[0][0]
    s.resolvePermission({ id, behavior: 'deny' })
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'Denied by user.' })
  })

  it('"permitir tudo" (bypass) NÃO pede e auto-aprova com updatedInput', async () => {
    const { s, ask } = makeSession()
    s.setBypass(true) // equivale ao usuário marcar "permitir tudo"
    const input = { command: 'rm -rf build', timeout: 1000 }
    const res = await gate(s, 'Bash', input)
    expect(ask).not.toHaveBeenCalled()
    expect(res).toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('"permitir tudo" NÃO atravessa o gate independente do Windows', async () => {
    const { s, ask } = makeSession()
    s.setBypass(true)
    const input = { windowId: '123' }
    const res = await gate(s, 'mcp__windows__windows_click', input)
    expect(ask).not.toHaveBeenCalled()
    expect(res).toEqual({
      behavior: 'deny',
      message: 'Controle do Windows desativado. Ative “Permitir controle do Windows” nas Configurações.'
    })
  })

  it('toggle do Windows ligado autoriza as ferramentas windows sem modal por clique', async () => {
    configState.windowsControlEnabled = true
    const { s, ask } = makeSession()
    const input = { windowId: '123', text: 'oi' }
    const res = await gate(s, 'mcp__windows__windows_type_text', input)
    expect(ask).not.toHaveBeenCalled()
    expect(res).toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('config corrompida falha fechada no gate do Windows', async () => {
    configState.windowsControlEnabled = 'true'
    const { s } = makeSession()
    await expect(gate(s, 'mcp__windows__windows_click', { windowId: '123' })).resolves.toMatchObject({
      behavior: 'deny'
    })
  })

  it('ligar "permitir tudo" ao vivo resolve a permissão pendente (com updatedInput)', async () => {
    const { s, ask } = makeSession()
    const input = { command: 'ls' }
    const p = gate(s, 'Bash', input)
    expect(ask).toHaveBeenCalledTimes(1)
    s.setBypass(true)
    await expect(p).resolves.toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('dispose nega permissões pendentes para não deixar a Query antiga viva', async () => {
    const { s } = makeSession()
    const pending = gate(s, 'Bash', { command: 'echo pending' })
    s.dispose()
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', message: expect.stringMatching(/closed/i) })
  })
})

describe('AgentSession — escopo de escrita da tarefa reivindicada (imposto fora do LLM)', () => {
  const scoped = (s: AgentSession): Map<string, unknown> =>
    (s as unknown as { scopedTasks: Map<string, unknown> }).scopedTasks
  const cwd = process.platform === 'win32' ? 'C:\\proj' : '/proj'
  const file = (rel: string): string => (process.platform === 'win32' ? `${cwd}\\${rel.replace(/\//g, '\\')}` : `${cwd}/${rel}`)

  const hold = (s: AgentSession, overrides: Record<string, unknown> = {}): void => {
    scoped(s).set('t1', {
      id: 't1',
      title: 'Só tasks',
      projectCwd: cwd,
      writeScope: { allow: ['src/tasks/**'], deny: [] },
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      holder: null,
      ...overrides
    })
  }
  // handlePermission é privado; o 4º argumento é o agentID do SDK.
  const gateAs = (s: AgentSession, agentId: string | undefined, name: string, input: Record<string, unknown>): Promise<unknown> =>
    (s as unknown as { handlePermission(n: string, i: Record<string, unknown>, a?: string): Promise<unknown> })
      .handlePermission(name, input, agentId)

  it('com "Permitir tudo" ligado, Write fora do escopo ainda é recusado; dentro, liberado com updatedInput', async () => {
    const { s } = makeSession({ cwd })
    s.setBypass(true)
    hold(s)

    const denied = (await gate(s, 'Write', { file_path: file('src/memory/x.ts'), content: '' })) as { behavior: string; message: string }
    expect(denied.behavior).toBe('deny')
    expect(denied.message).toContain('Só tasks')

    const input = { file_path: file('src/tasks/x.ts'), content: 'ok' }
    expect(await gate(s, 'Write', input)).toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('lease expirado solta o gate — subagente que morre não prende a sessão para sempre', async () => {
    const { s } = makeSession({ cwd })
    s.setBypass(true)
    hold(s, { leaseExpiresAt: new Date(Date.now() - 1).toISOString() })
    const input = { file_path: file('src/memory/x.ts'), content: '' }
    expect(await gate(s, 'Write', input)).toEqual({ behavior: 'allow', updatedInput: input })
  })

  it('escopo preso por um subagente não bloqueia o supervisor, mas bloqueia o próprio subagente', async () => {
    const { s } = makeSession({ cwd })
    s.setBypass(true)
    hold(s, { holder: 'sub-a' })
    const input = { file_path: file('src/memory/x.ts'), content: '' }

    // Supervisor (sem agentID) segue livre enquanto delega.
    expect(await gateAs(s, undefined, 'Write', input)).toEqual({ behavior: 'allow', updatedInput: input })
    // O executor que reivindicou, não.
    expect(await gateAs(s, 'sub-a', 'Write', input)).toMatchObject({ behavior: 'deny' })
  })

  it('task_claim registra o agente dono do escopo', async () => {
    const { s } = makeSession({ cwd })
    s.setBypass(true)
    const claiming = (): unknown => (s as unknown as { claimingAgent: string | null }).claimingAgent
    await gateAs(s, 'sub-b', 'mcp__tasks__task_claim', { task_id: 't9' })
    expect(claiming()).toBe('sub-b')
    await gateAs(s, undefined, 'mcp__tasks__task_claim', {})
    expect(claiming()).toBeNull()
  })

  it('sem tarefa com escopo, o gate não muda', async () => {
    const { s } = makeSession({ cwd })
    s.setBypass(true)
    const input = { file_path: file('qualquer.ts'), content: '' }
    expect(await gate(s, 'Write', input)).toEqual({ behavior: 'allow', updatedInput: input })
  })
})

describe('AgentSession — controle seguro do /loop', () => {
  const wakeup = {
    delaySeconds: 60,
    reason: 'Verificar novamente a condição pedida.',
    prompt: '/loop verificar até concluir'
  }

  it('usa 100 por padrão e só aceita número ligado explicitamente ao loop', () => {
    expect(loopLimitFromPrompt('verifique a porta 3000 até funcionar')).toBe(DEFAULT_LOOP_LIMIT)
    expect(loopLimitFromPrompt('tente até 250 vezes')).toBe(250)
    expect(loopLimitFromPrompt('limite do loop: 450')).toBe(450)
    expect(loopLimitFromPrompt('loop limit 999999')).toBe(MAX_LOOP_LIMIT)
    expect(loopLimitFromPrompt('tente até 20 vezes')).toBe(DEFAULT_LOOP_LIMIT)
  })

  it.each(['claude-opus-4-8', 'gpt-6-luna'])(
    'transforma mensagem normal em /loop só no payload do SDK (%s)',
    async (model) => {
      const { s } = makeSession({ loopEnabled: true, model })
      await s.send('verifique o deploy')
      const content = String(pushedMessages(s)[0]?.message.content)
      expect(content).toMatch(/^\/loop /)
      expect(content).toContain('verifique o deploy')
      await expect(gate(s, 'ScheduleWakeup', wakeup)).resolves.toEqual({
        behavior: 'allow',
        updatedInput: wakeup
      })
    }
  )

  it('mantém envio normal com Loop desligado', async () => {
    const { s } = makeSession()
    await s.send('verifique o deploy')
    const content = String(pushedMessages(s)[0]?.message.content)
    expect(content).toContain('verifique o deploy')
    expect(content).not.toContain('/loop verifique o deploy')
  })

  it('não duplica /loop explícito e mantém o comando no início do payload', async () => {
    const { s } = makeSession({ loopEnabled: true })
    await s.send('/loop verifique o deploy')
    const content = String(pushedMessages(s)[0]?.message.content)
    expect(content).toMatch(/^\/loop /)
    expect(content.match(/\/loop/giu)).toHaveLength(1)
    expect(content).toContain('verifique o deploy')
  })

  it.each(['/help', '  /review 123'])('não envolve outro comando slash: %s', async (text) => {
    const { s } = makeSession({ loopEnabled: true })
    await s.send(text)
    const content = String(pushedMessages(s)[0]?.message.content)
    expect(content).toContain(text)
    expect(content).not.toContain('/loop')
  })

  it('não inicia um loop novo para continuação interna de recuperação', async () => {
    const { s } = makeSession({ loopEnabled: true })
    await s.send('Retome a solicitação anterior.', undefined, undefined, 'pc', 'recovery')
    const content = String(pushedMessages(s)[0]?.message.content)
    expect(content).not.toContain('/loop Retome a solicitação anterior.')
    await expect(gate(s, 'ScheduleWakeup', wakeup)).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('bloqueia a skill loop quando o toggle está desligado', async () => {
    const { s } = makeSession()
    await expect(gate(s, 'Skill', { skill: 'loop' })).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/toggle.*Loop/i)
    })
  })

  it('bloqueia ScheduleWakeup fora de uma skill loop ativa mesmo com toggle ligado', async () => {
    const { s } = makeSession({ loopEnabled: true })
    await expect(gate(s, 'ScheduleWakeup', wakeup)).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/skill \/loop/i)
    })
  })

  it.each(['claude-opus-4-8', 'gpt-6-luna'])(
    'autoriza wakeup válido no mesmo gate compartilhado (%s)',
    async (model) => {
    const { s, ask } = makeSession({ loopEnabled: true, model })
    void gate(s, 'Skill', { skill: 'loop' })
    await expect(gate(s, 'ScheduleWakeup', wakeup)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: wakeup
    })
    expect(ask).not.toHaveBeenCalled() // o toggle Loop já é a autorização explícita
    }
  )

  it('rejeita campos inventados pelo GPT', async () => {
    const { s } = makeSession({ loopEnabled: true, skipPermissions: true })
    s.setBypass(true)
    await gate(s, 'Skill', { skill: 'loop' })
    await expect(gate(s, 'ScheduleWakeup', { ...wakeup, noop: true })).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/noop/)
    })
  })

  it('interromper limpa a autorização antes que um wakeup atrasado chegue', async () => {
    const { s } = makeSession({ loopEnabled: true })
    await s.send('continue verificando')
    await s.interrupt()
    await expect(gate(s, 'ScheduleWakeup', wakeup)).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('dispose limpa a autorização e nega wakeups atrasados', async () => {
    const { s } = makeSession({ loopEnabled: true })
    await s.send('continue verificando')
    s.dispose()
    await expect(gate(s, 'ScheduleWakeup', wakeup)).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('stop:true encerra o loop e bloqueia wakeups posteriores', async () => {
    const { s } = makeSession({ loopEnabled: true, skipPermissions: true })
    s.setBypass(true)
    await gate(s, 'Skill', { skill: 'loop' })
    await expect(gate(s, 'ScheduleWakeup', { stop: true })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { stop: true }
    })
    await expect(gate(s, 'ScheduleWakeup', wakeup)).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('interrompe no limite configurado antes de criar outro wakeup', async () => {
    const { s } = makeSession({ loopEnabled: true })
    Object.assign(s as unknown as Record<string, unknown>, {
      loopActive: true,
      loopCycles: DEFAULT_LOOP_LIMIT,
      loopLimit: DEFAULT_LOOP_LIMIT
    })
    await expect(gate(s, 'ScheduleWakeup', wakeup)).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/100 ciclos/)
    })
  })

  it('modo econômico vence mesmo se um estado corrompido trouxer loop ligado', async () => {
    const { s } = makeSession({ loopEnabled: true, economyMode: true, skipPermissions: true })
    await expect(gate(s, 'Skill', { skill: 'loop' })).resolves.toMatchObject({ behavior: 'deny' })
  })
})

describe('AgentSession — skills do modo econômico (caveman + rtk)', () => {
  for (const skill of ['caveman', 'rtk']) {
    it(`libera "${skill}" sem modal quando o toggle Econômico está ligado`, async () => {
      const { s, ask } = makeSession({ economyMode: true })
      await expect(gate(s, 'Skill', { skill })).resolves.toMatchObject({
        behavior: 'allow',
        updatedInput: { skill }
      })
      // O toggle é o consentimento: nada pode ir parar no modal de permissão.
      expect(ask).not.toHaveBeenCalled()
    })

    it(`nega "${skill}" com o toggle desligado`, async () => {
      const { s } = makeSession({})
      await expect(gate(s, 'Skill', { skill })).resolves.toMatchObject({ behavior: 'deny' })
    })
  }

  it('modo econômico anexa o lembrete por envio; desligado, não', async () => {
    const on = makeSession({ economyMode: true })
    await on.s.start()
    await on.s.send('rode os testes')
    const sentOn = String(pushedMessages(on.s).at(-1)?.message.content)
    expect(sentOn).toContain(ECONOMY_TURN_REMINDER)
    // O lembrete fica colado ao texto do usuário, depois de todo o contexto.
    expect(sentOn.indexOf(ECONOMY_TURN_REMINDER)).toBeLessThan(sentOn.indexOf('rode os testes'))
    expect(sentOn.indexOf(ECONOMY_TURN_REMINDER)).toBeGreaterThan(sentOn.indexOf('[PROJECT_DOCS_CONTEXT]'))

    const off = makeSession({})
    await off.s.start()
    await off.s.send('rode os testes')
    expect(String(pushedMessages(off.s).at(-1)?.message.content)).not.toContain('MODO ECONÔMICO')
  })

  it('nega mesmo com prefixo de plugin (plugin:rtk)', async () => {
    const { s } = makeSession({})
    await expect(gate(s, 'Skill', { skill: 'plugin:rtk' })).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('não confunde uma skill de nome parecido', async () => {
    const { s, ask } = makeSession({ economyMode: true })
    // "rtk-extra" não é a skill liberada: precisa cair no fluxo normal (modal).
    void gate(s, 'Skill', { skill: 'rtk-extra' })
    expect(ask).toHaveBeenCalled()
  })
})

describe('AgentSession — AskUserQuestion (pergunta interativa)', () => {
  const askInput = {
    questions: [
      {
        header: 'Lib',
        question: 'Qual lib usar?',
        multiSelect: false,
        options: [
          { label: 'Zod', description: 'schemas' },
          { label: 'Yup', description: 'outra' }
        ]
      }
    ]
  }

  it('mostra a pergunta na UI com as opções tipadas (não cai no modal de permissão)', () => {
    const { s, ask } = makeSession()
    void gate(s, 'AskUserQuestion', askInput)
    expect(ask).toHaveBeenCalledTimes(1)
    const req = ask.mock.calls[0][0]
    expect(req.toolName).toBe('AskUserQuestion')
    expect(req.questions).toHaveLength(1)
    expect(req.questions[0]).toMatchObject({ header: 'Lib', multiSelect: false })
    expect(req.questions[0].options[0]).toEqual({ label: 'Zod', description: 'schemas' })
  })

  it('a resposta do usuário volta ao modelo como mensagem (deny com o texto da escolha)', async () => {
    const { s, ask } = makeSession()
    const p = gate(s, 'AskUserQuestion', askInput)
    const { id } = ask.mock.calls[0][0]
    s.resolvePermission({ id, behavior: 'allow', answers: [{ header: 'Lib', question: 'Qual lib usar?', selected: ['Zod'] }] })
    const res = (await p) as { behavior: string; message: string }
    expect(res.behavior).toBe('deny')
    expect(res.message).toContain('Lib: Zod')
  })

  it('"permitir tudo" NÃO responde a pergunta automaticamente (precisa do usuário)', async () => {
    const { s, ask } = makeSession()
    let settled = false
    const p = gate(s, 'AskUserQuestion', askInput).then((r) => {
      settled = true
      return r
    })
    s.setBypass(true)
    // dá um tick pro then rodar caso (erroneamente) resolvesse
    await Promise.resolve()
    expect(settled).toBe(false)
    // ainda dá pra responder normalmente depois
    const { id } = ask.mock.calls[0][0]
    s.resolvePermission({ id, behavior: 'allow', answers: [{ header: 'Lib', question: 'Qual lib usar?', selected: ['Yup'] }] })
    await expect(p).resolves.toMatchObject({ behavior: 'deny' })
  })
})

// O Stop tem um caso que parecia "o botão não funciona": o turno não estava
// rodando, estava PENDURADO numa permissão/pergunta esperando o usuário. O
// `interrupt()` do SDK não resolve essa promessa — quem resolve é isto aqui.
describe('AgentSession — Stop com pedido pendente na tela', () => {
  const askInput = { questions: [{ header: 'X', question: 'Q?', multiSelect: false, options: [{ label: 'A', description: '' }] }] }

  it('nega a permissão pendente e fecha o modal', async () => {
    const { s, ask, expire } = makeSession()
    const p = gate(s, 'Bash', { command: 'npm run build' })
    const { id } = ask.mock.calls[0][0]
    await s.interrupt()
    const res = (await p) as { behavior: string; message: string }
    expect(res.behavior).toBe('deny')
    expect(res.message).toMatch(/parou o turno/i)
    expect(expire).toHaveBeenCalledWith(id)
  })

  it('uma pergunta aberta morre junto com o turno parado', async () => {
    const { s, ask, expire } = makeSession()
    const p = gate(s, 'AskUserQuestion', askInput)
    const { id } = ask.mock.calls[0][0]
    await s.interrupt()
    await expect(p).resolves.toMatchObject({ behavior: 'deny' })
    expect(expire).toHaveBeenCalledWith(id)
  })

  it('sem nada pendente, o Stop não inventa negativa nenhuma', async () => {
    const { s, expire } = makeSession()
    await expect(s.interrupt()).resolves.toEqual({ stillQueued: [] })
    expect(expire).not.toHaveBeenCalled()
  })
})

describe('AgentSession — auto-timeout (sem resposta do usuário)', () => {
  const askInput = { questions: [{ header: 'X', question: 'Q?', multiSelect: false, options: [{ label: 'A', description: '' }] }] }

  it('manda um deadline futuro na requisição', () => {
    const { s, ask } = makeSession()
    const before = Date.now()
    void gate(s, 'Bash', { command: 'ls' })
    const req = ask.mock.calls[0][0]
    expect(typeof req.deadline).toBe('number')
    expect(req.deadline).toBeGreaterThan(before)
  })

  it('permissão de ferramenta: no timeout auto-NEGA e avisa o renderer', async () => {
    vi.useFakeTimers()
    try {
      const { s, ask, expire } = makeSession()
      const p = gate(s, 'Bash', { command: 'rm -rf x' })
      const { id } = ask.mock.calls[0][0]
      vi.advanceTimersByTime(7 * 60_000 + 10)
      const res = (await p) as { behavior: string; message: string }
      expect(res.behavior).toBe('deny')
      expect(res.message).toMatch(/tempo|esgotado/i)
      expect(expire).toHaveBeenCalledWith(id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pergunta: no timeout prossegue (deny avisando que ninguém respondeu)', async () => {
    vi.useFakeTimers()
    try {
      const { s, ask, expire } = makeSession()
      const p = gate(s, 'AskUserQuestion', askInput)
      const { id } = ask.mock.calls[0][0]
      vi.advanceTimersByTime(7 * 60_000 + 10)
      const res = (await p) as { behavior: string; message: string }
      expect(res.behavior).toBe('deny')
      expect(res.message).toMatch(/não respondeu|sensata/i)
      expect(expire).toHaveBeenCalledWith(id)
    } finally {
      vi.useRealTimers()
    }
  })

  it('se o usuário responde a tempo, o timeout é cancelado (não dispara expire)', async () => {
    vi.useFakeTimers()
    try {
      const { s, ask, expire } = makeSession()
      const p = gate(s, 'Bash', { command: 'ls' })
      const { id } = ask.mock.calls[0][0]
      s.resolvePermission({ id, behavior: 'allow' })
      await p
      vi.advanceTimersByTime(7 * 60_000 + 10)
      expect(expire).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('AgentSession — result de subagente NÃO encerra o turno principal', () => {
  const baseResult = { type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 100 }

  it('result do turno principal (sem origin): emite kind:"result" normalmente', () => {
    const { s, emit } = makeSession()
    handle(s, baseResult)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', isError: false }))
  })

  it('reconcilia usage vazio do assistant com modelUsage final do result', () => {
    const { s, emit } = makeSession()
    handle(s, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        model: 'claude-sonnet-5',
        usage: {},
        content: [{ type: 'text', text: 'resposta' }]
      }
    })
    handle(s, {
      ...baseResult,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {
        'claude-sonnet-5': {
          inputTokens: 31,
          outputTokens: 17,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 2
        }
      }
    })
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'result',
        usage: { input: 31, output: 17, cacheRead: 5, cacheWrite: 2 }
      })
    )
  })

  it('result com origin humano/normal (kind !== "peer"): emite normalmente', () => {
    const { s, emit } = makeSession()
    handle(s, { ...baseResult, origin: { kind: 'human' } })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result' }))
  })

  it('result de SUBAGENTE em background (origin.kind === "peer"): NÃO emite — não pode desligar o indicador de "trabalhando" do turno principal', () => {
    const { s, emit } = makeSession()
    handle(s, { ...baseResult, origin: { kind: 'peer', from: 'task-123' } })
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('AgentSession — novos sinais de interrupção e background', () => {
  it('carimba a mensagem e devolve still_queued com o texto correspondente', async () => {
    const { s } = makeSession()
    await s.send('rode depois do Stop', undefined, '11111111-1111-4111-8111-111111111111')
    const q = { interrupt: vi.fn(async () => ({ still_queued: ['11111111-1111-4111-8111-111111111111'] })) }
    ;(s as unknown as { q: typeof q }).q = q

    await expect(s.interrupt()).resolves.toEqual({
      stillQueued: [{ messageId: '11111111-1111-4111-8111-111111111111', text: 'rode depois do Stop' }]
    })
    expect(pushedMessages(s)[0].uuid).toBe('11111111-1111-4111-8111-111111111111')
  })

  it('marca a resposta final como aborted quando o SDK corta o stream', () => {
    const { s, emit } = makeSession()
    handle(s, { type: 'stream_event', event: { type: 'message_start', message: { id: 'a-abort' } } })
    handle(s, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'resposta cor' } } })
    handle(s, {
      type: 'assistant',
      aborted: true,
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'resposta cor' }] }
    })
    expect(emit).toHaveBeenLastCalledWith({
      kind: 'assistant-text',
      id: 'a-abort',
      text: 'resposta cor',
      final: true,
      aborted: true
    })
  })

  it('replaces the full background task snapshot and resets it on init', () => {
    const { s, emit } = makeSession()
    handle(s, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'bg-1', task_type: 'bash', description: 'Servidor local' }]
    })
    expect(emit).toHaveBeenLastCalledWith({
      kind: 'background-tasks',
      tasks: [{ id: 'bg-1', type: 'bash', description: 'Servidor local' }]
    })

    handle(s, { type: 'system', subtype: 'init', session_id: 's1', model: 'opus', cwd: '/proj', tools: [] })
    expect(emit).toHaveBeenLastCalledWith({ kind: 'background-tasks', tasks: [] })
  })
})

describe('AgentSession — "/compact" (verificado ao vivo: o SDK não intercepta o comando)', () => {
  // Confirmado contra uma sessão real (LIVE_AGENT=1): mandar o texto literal
  // "/compact" nunca gera um system/compact_boundary neste modo — o modelo só
  // responde "não reconheço esse comando". send() por isso intercepta ele
  // localmente, sem gastar um turno com uma resposta que ninguém quer.
  it('não envia nada ao SDK e avisa que a compactação manual não está disponível', async () => {
    const { s, emit } = makeSession()
    await s.send('/compact')
    expect(pushedMessages(s)).toEqual([])
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'status', text: expect.stringContaining('Compactação manual não está disponível') })
    )
  })

  it('não intercepta "/compact" como parte de um texto maior', async () => {
    const { s } = makeSession()
    await s.send('/compact isso aqui não é o comando')
    expect(pushedMessages(s).length).toBeGreaterThan(0)
  })

  // Defensivo: se uma versão futura do SDK vier a emitir esse evento (ele existe
  // nos tipos e no parser de transcript do próprio pacote), a tradução para a UI
  // já está pronta — mas hoje isto nunca é atingido por digitação manual.
  describe('handler de system/compact_boundary (código defensivo, ainda não observado ao vivo)', () => {
    it('emite kind:"status" com a contagem de tokens quando o campo existe', () => {
      const { s, emit } = makeSession()
      handle(s, {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 120000, post_tokens: 8000 }
      })
      expect(emit).toHaveBeenLastCalledWith({
        kind: 'status',
        id: expect.any(String),
        text: 'Conversa compactada (manual) — 120.000 → 8.000 tokens'
      })
    })

    it('usa o rótulo automático e funciona sem metadados de tokens', () => {
      const { s, emit } = makeSession()
      handle(s, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } })
      expect(emit).toHaveBeenLastCalledWith({
        kind: 'status',
        id: expect.any(String),
        text: 'Conversa compactada (automática (contexto cheio))'
      })
    })
  })
})

describe('AgentSession — rate_limit_event (uso de 5h/semana da conta)', () => {
  it('emite kind:"rate-limit" com os campos do rate_limit_info', () => {
    const { s, emit } = makeSession()
    handle(s, {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.62, resetsAt: 1234 },
      uuid: 'u1',
      session_id: 'sess1'
    })
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'rate-limit',
        limits: expect.objectContaining({
          rateLimitType: 'five_hour',
          status: 'allowed_warning',
          utilization: 0.62,
          resetsAt: 1234
        })
      })
    )
  })

  it('sem rateLimitType (evento ainda não classificado): não emite nada', () => {
    const { s, emit } = makeSession()
    handle(s, { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: 'u1', session_id: 'sess1' })
    expect(emit).not.toHaveBeenCalled()
  })

  it('mensagem SDK desconhecida (default): não quebra, não emite', () => {
    const { s, emit } = makeSession()
    expect(() => handle(s, { type: 'some_future_message_type' })).not.toThrow()
    expect(emit).not.toHaveBeenCalled()
  })

  it('refreshUsage() emite rate-limit a partir do endpoint experimental', async () => {
    const { s, emit } = makeSession()
    const q = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => ({
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: '2026-07-01T00:00:00.000Z' },
          seven_day: { utilization: 10, resets_at: null },
          extra_usage: { is_enabled: true, utilization: 5 }
        }
      }))
    }
    ;(s as unknown as { q: typeof q }).q = q
    await s.refreshUsage()
    expect(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'rate-limit',
        limits: expect.objectContaining({ rateLimitType: 'five_hour', utilization: 0.42, status: 'allowed' })
      })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'rate-limit',
        limits: expect.objectContaining({ rateLimitType: 'seven_day', utilization: 0.1, status: 'allowed' })
      })
    )
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'rate-limit',
        limits: expect.objectContaining({ rateLimitType: 'overage', utilization: 0.05, status: 'allowed' })
      })
    )
  })
})

describe('AgentSession — vision_fallback_router', () => {
  beforeEach(() => {
    describeImagesMock.mockReset()
  })

  it('modelo Ollama SEM visão (ex.: GLM) + imagem: intercepta, chama o relay e envia só texto com [VISUAL_CONTEXT]', async () => {
    describeImagesMock.mockResolvedValueOnce('Texto visível (OCR completo): Erro 500\nErros encontrados: servidor caiu')
    const { s } = makeSession({ model: 'glm-5.3:cloud' })

    await s.send('o que é esse erro?', [{ mediaType: 'image/png', data: 'AAAA' }])

    expect(describeImagesMock).toHaveBeenCalledTimes(1)
    expect(describeImagesMock).toHaveBeenCalledWith(
      [{ mediaType: 'image/png', data: 'AAAA' }],
      'o que é esse erro?'
    )
    const [msg] = pushedMessages(s)
    // Sem imagem nenhuma chegando ao modelo de texto — só a string com o bloco.
    expect(typeof msg.message.content).toBe('string')
    const content = msg.message.content as string
    expect(content).toContain('Mensagem original do usuário:\no que é esse erro?')
    expect(content).toContain('[VISUAL_CONTEXT]')
    expect(content).toContain('Erro 500')
    expect(content).toContain('[/VISUAL_CONTEXT]')
  })

  it('modelo Ollama SEM visão, relay falha: degrada com aviso mas NÃO trava o envio', async () => {
    describeImagesMock.mockRejectedValueOnce(new Error('timeout'))
    const { s } = makeSession({ model: 'muse-glimmer:cloud' })

    await s.send('descreva a tela', [{ mediaType: 'image/png', data: 'AAAA' }])

    const [msg] = pushedMessages(s)
    const content = msg.message.content as string
    expect(content).toContain('descreva a tela')
    expect(content).toContain('não foi possível analisar')
  })

  it('modelo COM visão nativa (Claude) + imagem: NÃO chama o relay, envia a imagem direto', async () => {
    const { s } = makeSession({ model: 'claude-sonnet-5' })

    await s.send('o que é isso?', [{ mediaType: 'image/png', data: 'AAAA' }])

    expect(describeImagesMock).not.toHaveBeenCalled()
    const [msg] = pushedMessages(s)
    expect(Array.isArray(msg.message.content)).toBe(true)
    const blocks = msg.message.content as Array<{ type: string }>
    expect(blocks.some((b) => b.type === 'image')).toBe(true)
  })

  it('Kimi K3 (Ollama, único com visão) + imagem: NÃO chama o relay', async () => {
    const { s } = makeSession({ model: 'kimi-k3:cloud' })

    await s.send('o que é isso?', [{ mediaType: 'image/png', data: 'AAAA' }])

    expect(describeImagesMock).not.toHaveBeenCalled()
    const [msg] = pushedMessages(s)
    expect(Array.isArray(msg.message.content)).toBe(true)
  })

  it('sem imagem: fluxo idêntico ao atual, relay nunca é chamado', async () => {
    const { s } = makeSession({ model: 'glm-5.3:cloud' })

    await s.send('só texto, sem imagem')

    expect(describeImagesMock).not.toHaveBeenCalled()
    const [msg] = pushedMessages(s)
    // O texto persistido recebe o carimbo e atualizações de catálogo, mas nunca
    // o bloco completo de docs: ele é anexado pelo hook imediatamente antes da request.
    const content = msg.message.content as string
    expect(content).not.toContain('[PROJECT_DOCS_CONTEXT]')
    expect(content).toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(content).toContain('só texto, sem imagem')
  })
})

describe('AgentSession — modo rápido (settings.fastMode) enviado ao SDK', () => {
  const optionsOfLastQuery = (): Record<string, unknown> =>
    (queryMock.mock.calls.at(-1)?.[0] as { options: Record<string, unknown> }).options

  beforeEach(() => queryMock.mockClear())

  it('modelo suportado + flag ligada: manda settings.fastMode', async () => {
    const { s } = makeSession({ model: 'claude-opus-5-5', fastMode: true })
    await s.start()
    expect(optionsOfLastQuery().settings).toEqual({ fastMode: true })
  })

  it('flag desligada: não manda settings (fica no padrão da conta)', async () => {
    const { s } = makeSession({ model: 'claude-opus-5-5', fastMode: false })
    await s.start()
    expect(optionsOfLastQuery().settings).toBeUndefined()
  })

  // A proteção que importa: mesmo se a flag vazar de uma conversa antiga, um
  // modelo sem suporte não pode receber fastMode — a API rejeitaria a request.
  it('modelo sem suporte + flag ligada: settings NÃO vai junto', async () => {
    const { s } = makeSession({ model: 'claude-sonnet-5', fastMode: true })
    await s.start()
    expect(optionsOfLastQuery().settings).toBeUndefined()
  })

  // GPT tem modo rápido, mas por outro canal: `service_tier` no corpo do Codex.
  // Mandar `settings.fastMode` para lá seria um campo Anthropic num backend que
  // rejeita parâmetro desconhecido com HTTP 400.
  it('GPT + flag ligada: NÃO manda settings, e pede fast mode pelo token do proxy', async () => {
    const { s } = makeSession({ model: 'gpt-6-sol', fastMode: true })
    await s.start()
    const options = optionsOfLastQuery()
    expect(options.settings).toBeUndefined()
    expect((options.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toMatch(/\+fast$/)
  })

  it('GPT + flag desligada: token do proxy sai sem o sufixo', async () => {
    const { s } = makeSession({ model: 'gpt-6-sol', fastMode: false })
    await s.start()
    const options = optionsOfLastQuery()
    expect(options.settings).toBeUndefined()
    expect((options.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).not.toMatch(/\+fast$/)
  })
})

// O CLI prefere a credencial guardada do login do claude.ai ao token que a
// gente passa. Com o ANTHROPIC_BASE_URL fora da Anthropic, ele mandava o
// `sk-ant-…` do usuário para o proxy do Codex, que respondia 401 — e o CLI
// reentrava para sempre. O turno nunca terminava: sem resposta e sem erro.
describe('AgentSession — backend de fora não recebe o login guardado', () => {
  const optionsOfLastQuery = (): Record<string, unknown> =>
    (queryMock.mock.calls.at(-1)?.[0] as { options: Record<string, unknown> }).options

  let home = ''
  let cache = ''
  let previousConfigDir: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cli-home-'))
    cache = await mkdtemp(join(tmpdir(), 'cli-cache-'))
    await writeFile(join(home, 'CLAUDE.md'), '# instruções globais do usuário', 'utf8')
    await writeFile(join(home, 'settings.json'), '{"a":1}', 'utf8')
    await writeFile(join(home, '.credentials.json'), '{"token":"sk-ant-SEGREDO"}', 'utf8')
    previousConfigDir = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = home
    cacheState.dir = join(cache, 'sincronizada')
    cacheState.localDir = cache
  })

  afterEach(async () => {
    if (previousConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
    else process.env['CLAUDE_CONFIG_DIR'] = previousConfigDir
    cacheState.dir = 'C:\\test\\agent-code'
    cacheState.localDir = 'C:\\test\\agent-code-local'
    await rm(home, { recursive: true, force: true })
    await rm(cache, { recursive: true, force: true })
  })

  it('GPT: aponta o CLI para um diretório SEM credencial, levando CLAUDE.md e settings', async () => {
    const { s } = makeSession({ model: 'gpt-6-sol' })
    await s.start()
    const env = optionsOfLastQuery().env as Record<string, string>
    const dir = env.CLAUDE_CONFIG_DIR

    expect(dir).toBeTruthy()
    expect(dir).not.toBe(home) // é o ponto: a credencial do usuário não vai junto
    // Na raiz local: o CLI grava transcrições ali a cada turno.
    expect(dir).toBe(join(cache, 'cli-config-sem-login'))
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
    // …mas o que o usuário percebe se sumir continua lá.
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('instruções globais')
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
  })

  it('Ollama: mesmo desvio — o backend também não é a Anthropic', async () => {
    configState.ollama = { enabled: true, apiKey: 'chave-ollama' }
    const { s } = makeSession({ model: 'gpt-oss:20b-cloud' })
    await s.start()
    const env = optionsOfLastQuery().env as Record<string, string>
    expect(env.CLAUDE_CONFIG_DIR).toBeTruthy()
    expect(existsSync(join(env.CLAUDE_CONFIG_DIR, '.credentials.json'))).toBe(false)
  })

  it('GPT falha fechada se não puder criar a raiz isolada, sem iniciar o proxy', async () => {
    await rm(cache, { recursive: true, force: true })
    cache = join(home, 'cache-file')
    await writeFile(cache, 'not a directory', 'utf8')
    cacheState.localDir = cache

    const { s } = makeSession({ model: 'gpt-6-sol' })
    await expect(s.start()).resolves.toBe(false)

    expect(ensureCodexProxyMock).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('GPT lê snapshots task-list da raiz isolada efetiva, não da raiz Claude do processo', async () => {
    const { s, emit } = makeSession({ model: 'gpt-6-sol' })
    await s.start()
    const env = optionsOfLastQuery().env as Record<string, string>
    const taskDir = join(env.CLAUDE_CONFIG_DIR, 'tasks', 'gpt-session')
    await mkdir(taskDir, { recursive: true })
    await writeFile(join(taskDir, '1.json'), JSON.stringify({ id: '1', subject: 'Snapshot GPT', status: 'in_progress' }))

    handle(s, { type: 'system', subtype: 'init', session_id: 'gpt-session', model: 'gpt', cwd: '/project', tools: [] })

    expect(emit).toHaveBeenCalledWith({
      kind: 'task-list',
      items: [{ id: '1', content: 'Snapshot GPT', status: 'in_progress', activeForm: 'Snapshot GPT' }]
    })
  })

  // O desvio existe só por causa do backend de fora. Numa sessão da Anthropic o
  // login guardado é exatamente o que deve valer.
  it('Claude: NÃO desvia nada (o login guardado é o certo ali)', async () => {
    const { s } = makeSession({ model: 'claude-opus-5' })
    await s.start()
    expect(optionsOfLastQuery().env).toBeUndefined()
  })
})

describe('AgentSession — GPT mantém o mesmo harness do Claude', () => {
  const optionsOfLastQuery = (): Record<string, unknown> =>
    (queryMock.mock.calls.at(-1)?.[0] as { options: Record<string, unknown> }).options

  it('preserva ferramentas/permissões e fixa todos os subagentes no GPT selecionado', async () => {
    const { s } = makeSession({ model: 'gpt-6-sol', effort: 'max' })
    await s.start()

    const options = optionsOfLastQuery()
    const env = options.env as Record<string, string>
    expect(options).toMatchObject({
      cwd: '/proj',
      model: 'gpt-6-sol',
      effort: 'max',
      maxTurns: OPENAI_MAX_TURNS,
      permissionMode: 'default',
      skills: 'all',
      additionalDirectories: expect.arrayContaining([
        'C:\\test\\agent-code\\memories',
        'C:\\test\\agent-code\\skills'
      ]),
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' }
    })
    expect(options.mcpServers).toBeDefined()
    expect(options.canUseTool).toEqual(expect.any(Function))
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:43210',
      ANTHROPIC_AUTH_TOKEN: 'local-test-secret',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-6-sol',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-6-sol',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-6-sol',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'gpt-6-sol',
      CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-6-sol'
    })
  })

  it('expõe a pasta de skills do cache ao GPT mesmo quando a conversa usa outro projeto', async () => {
    const { s } = makeSession({ model: 'gpt-6-sol', cwd: 'C:\\outro-projeto-sem-skills' })
    await s.start()
    const options = optionsOfLastQuery()
    expect(options.skills).toBe('all')
    expect(options.additionalDirectories).toEqual(expect.arrayContaining(['C:\\test\\agent-code\\skills']))
  })

  it('sincroniza skill .agents e só anuncia após confirmação do registro nativo', async () => {
    const project = await mkdtemp(join(tmpdir(), 'agent-session-skills-'))
    const home = join(project, 'home')
    const cache = join(project, 'cache')
    cacheState.dir = cache
    cacheState.skillsDir = join(cache, 'skills')
    const skillDir = join(project, '.agents', 'skills', 'modelar')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: modelar\ndescription: editar qualquer arquivo STL ou 3MF\n---\n\nCORPO_NAO_VAI_NO_PROMPT',
      'utf8'
    )
    const { s } = makeSession({
      cwd: project,
      model: 'gpt-6-sol',
      skillRuntime: { appRoot: project, userHome: home }
    })

    await s.start()

    const options = optionsOfLastQuery()
    const systemPrompt = options.systemPrompt as { append: string }
    expect(systemPrompt.append).not.toContain('AUTHORITATIVE FILESYSTEM SKILLS CATALOG')
    expect(systemPrompt.append).not.toContain('/modelar')
    expect(options.additionalDirectories).toEqual(expect.arrayContaining([join(cache, 'skills')]))
    // The root the CLI really scans: <cache>/native/.claude/skills -> <cache>/skills.
    // (~/.claude/skills is NOT read by the SDK-driven CLI — measured, see skillManager.)
    expect(options.additionalDirectories).toEqual(expect.arrayContaining([join(cache, 'native')]))
    const nativeLink = join(cache, 'native', '.claude', 'skills')
    expect((await stat(nativeLink)).isDirectory()).toBe(true)
    expect(await readFile(join(nativeLink, 'modelar', 'SKILL.md'), 'utf8')).toContain('name: modelar')

    const reloadSkills = vi.fn(async () => ({
      skills: [{ name: 'modelar', description: 'editar', argumentHint: '' }]
    }))
    ;(s as unknown as { q: { reloadSkills: typeof reloadSkills } }).q = { reloadSkills }
    await s.send('use a skill')

    const dispatched = String(pushedMessages(s).at(-1)?.message.content)
    expect(dispatched).toContain('[SKILL_CATALOG_UPDATE]')
    expect(dispatched).toContain('/modelar')
    expect(dispatched).toContain('Description: editar qualquer arquivo STL ou 3MF')
    expect(dispatched).not.toContain('CORPO_NAO_VAI_NO_PROMPT')
  })

  it('nega escrita direta na pasta de memórias mesmo com "Permitir tudo"', async () => {
    const memories = await mkdtemp(join(tmpdir(), 'agent-session-memory-gate-'))
    cacheState.memoriesDir = memories
    const { s } = makeSession()
    s.setBypass(true)

    const denied = [
      ['Write', { file_path: join(memories, 'nota.md'), content: 'x' }],
      ['Edit', { file_path: join(memories, 'MEMORY.md'), old_string: 'a', new_string: 'b' }],
      // Subpasta que ainda não existe: é onde o modelo tenta agrupar memórias.
      ['Write', { file_path: join(memories, '2D', 'nota.md'), content: 'x' }],
      ['Bash', { command: `echo oi >> "${join(memories, 'MEMORY.md')}"` }]
    ] as const
    for (const [tool, input] of denied) {
      const result = (await gate(s, tool, input)) as { behavior: string; message: string }
      expect(result.behavior).toBe('deny')
      expect(result.message).toContain('memory_propose')
    }

    // Ler a pasta e escrever fora dela seguem liberados.
    expect(await gate(s, 'Read', { file_path: join(memories, 'nota.md') })).toMatchObject({ behavior: 'allow' })
    expect(await gate(s, 'Write', { file_path: join(tmpdir(), 'fora.md'), content: 'x' })).toMatchObject({
      behavior: 'allow'
    })
  })

  it('instrui o modelo a propor a memória em vez de escrever o arquivo', async () => {
    const { s } = makeSession()
    await s.start()
    const append = (optionsOfLastQuery().systemPrompt as { append: string }).append
    expect(append).toContain('memory_propose')
    expect(append).not.toContain('just\nwrite into it with your tools')
    expect(append).not.toContain('The folder already exists; just')
  })

  it('envia todas as memórias uma vez no system prompt inicial', async () => {
    const memories = await mkdtemp(join(tmpdir(), 'agent-session-memory-start-'))
    await mkdir(join(memories, 'produto'))
    await writeFile(join(memories, 'MEMORY.md'), '# Índice\n\n- [Preferência](produto/preferencia.md)', 'utf8')
    await writeFile(join(memories, 'produto', 'preferencia.md'), '# Preferência\nSempre usar o fluxo real.', 'utf8')
    cacheState.memoriesDir = memories
    const { s } = makeSession({ model: 'gpt-6-sol' })

    await s.start()

    const systemPrompt = optionsOfLastQuery().systemPrompt as { append: string }
    expect(systemPrompt.append).toContain('AUTHORITATIVE PERSISTENT MEMORY CATALOG')
    expect(systemPrompt.append).toContain('--- MEMORY FILE: MEMORY.md ---')
    expect(systemPrompt.append).not.toContain('--- MEMORY FILE: produto/preferencia.md ---')
    expect(systemPrompt.append).not.toContain('Sempre usar o fluxo real.')

    await s.send('sem mudança')
    expect(String(pushedMessages(s).at(-1)?.message.content)).not.toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(String(pushedMessages(s).at(-1)?.message.content)).not.toContain('Sempre usar o fluxo real.')
  })

  it('não entrega marcadores de segredo no catálogo inicial a nenhum provedor, preservando o índice', async () => {
    const memories = await mkdtemp(join(tmpdir(), 'agent-session-memory-redaction-'))
    await writeFile(
      join(memories, 'MEMORY.md'),
      '# Índice\n\n- [ERP](erp.md) — usar o fluxo real\nCofre: {{secret:erp-token}}',
      'utf8'
    )
    cacheState.memoriesDir = memories
    configState.ollama = { enabled: true, apiKey: 'chave-ollama' }

    let expectedAppend: string | undefined
    for (const model of ['claude-opus-5', 'gpt-6-sol', 'gpt-oss:20b-cloud']) {
      const { s } = makeSession({ model })
      await s.start()
      const append = (optionsOfLastQuery().systemPrompt as { append: string }).append
      expect(append, model).toContain('- [ERP](erp.md) — usar o fluxo real')
      expect(append, model).toContain('[secret reference withheld]')
      expect(append, model).not.toContain('{{secret:erp-token}}')
      expect(append, model).not.toContain('erp-token')
      expectedAppend ??= append
      expect(append, model).toBe(expectedAppend)
      s.dispose()
    }
  })

  it('atualiza uma vez a conversa aberta ao adicionar, alterar ou remover memória', async () => {
    const memories = await mkdtemp(join(tmpdir(), 'agent-session-memory-refresh-'))
    const memoryFile = join(memories, 'MEMORY.md')
    await writeFile(memoryFile, '# Regra\nVersão inicial.', 'utf8')
    cacheState.memoriesDir = memories
    const { s } = makeSession({ model: 'gpt-6-sol' })
    await s.start()

    await writeFile(memoryFile, '# Regra\nVersão atualizada e maior.\n{{secret:erp-token}}', 'utf8')
    await s.send('depois da alteração')
    const changed = String(pushedMessages(s).at(-1)?.message.content)
    expect(changed).toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(changed).toContain('Versão atualizada e maior.')
    expect(changed).toContain('[secret reference withheld]')
    expect(changed).not.toMatch(/\{\{secret:/iu)
    expect(changed).not.toContain('erp-token')
    expect(changed).not.toContain('Versão inicial.')

    await s.send('não repetir')
    expect(String(pushedMessages(s).at(-1)?.message.content)).not.toContain('[PERSISTENT_MEMORY_UPDATE]')

    await writeFile(join(memories, 'nova.md'), '# Nova\nAdicionada durante a conversa.', 'utf8')
    await s.send('depois da adição')
    expect(String(pushedMessages(s).at(-1)?.message.content)).not.toContain('Adicionada durante a conversa.')

    await rm(memoryFile)
    await s.send('depois da remoção')
    const removed = String(pushedMessages(s).at(-1)?.message.content)
    expect(removed).toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(removed).not.toContain('Versão atualizada e maior.')
  })

  it('atualiza memória quando o conteúdo muda com tamanho e timestamp iguais', async () => {
    const memories = await mkdtemp(join(tmpdir(), 'agent-session-memory-same-metadata-'))
    const memoryFile = join(memories, 'MEMORY.md')
    await writeFile(memoryFile, '# Regra AAAA\n', 'utf8')
    const metadata = await stat(memoryFile)
    cacheState.memoriesDir = memories
    const { s } = makeSession({ model: 'gpt-6-sol' })
    await s.start()

    await writeFile(memoryFile, '# Regra BBBB\n', 'utf8')
    await utimes(memoryFile, metadata.atime, metadata.mtime)
    await s.send('mudança preservou metadados')

    const update = String(pushedMessages(s).at(-1)?.message.content)
    expect(update).toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(update).toContain('# Regra BBBB')
    expect(update).not.toContain('# Regra AAAA')
  })

  it('recarrega o registro nativo antes do primeiro envio mesmo sem mudança no catálogo', async () => {
    const project = await mkdtemp(join(tmpdir(), 'agent-session-first-skill-reload-'))
    const home = join(project, 'home')
    const cache = join(project, 'cache')
    cacheState.dir = cache
    cacheState.skillsDir = join(cache, 'skills')
    const skillDir = join(project, '.claude', 'skills', '3d-print-modeling')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: 3d-print-modeling\ndescription: editar modelos 3D\n---\n',
      'utf8'
    )
    const { s } = makeSession({
      cwd: project,
      model: 'gpt-6-sol',
      skillRuntime: { appRoot: project, userHome: home }
    })
    await s.start()

    const reloadSkills = vi.fn(async () => ({
      skills: [{ name: '3d-print-modeling', description: 'editar modelos 3D', argumentHint: '' }]
    }))
    ;(s as unknown as { q: { reloadSkills: typeof reloadSkills } }).q = { reloadSkills }

    await s.send('edite o 3MF usando a skill')
    await s.send('continue sem recarregar de novo')

    expect(reloadSkills).toHaveBeenCalledTimes(1)
    expect(String(pushedMessages(s).at(-2)?.message.content)).toContain('[SKILL_CATALOG_UPDATE]')
    expect(String(pushedMessages(s).at(-1)?.message.content)).not.toContain('[SKILL_CATALOG_UPDATE]')
  })

  it('sincroniza, recarrega e injeta o catálogo quando .agents muda na conversa ativa', async () => {
    const project = await mkdtemp(join(tmpdir(), 'agent-session-skill-refresh-'))
    const home = join(project, 'home')
    const cache = join(project, 'cache')
    cacheState.dir = cache
    cacheState.skillsDir = join(cache, 'skills')
    const skillDir = join(project, '.agents', 'skills', 'dynamic')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: dynamic\ndescription: versão inicial\n---', 'utf8')
    const { s } = makeSession({
      cwd: project,
      model: 'gpt-6-sol',
      skillRuntime: { appRoot: project, userHome: home }
    })
    await s.start()
    await Promise.resolve()

    const reloadSkills = vi.fn(async () => ({
      skills: [{ name: 'dynamic', description: 'dinâmica', argumentHint: '' }]
    }))
    ;(s as unknown as { q: { reloadSkills: typeof reloadSkills } }).q = { reloadSkills }
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: dynamic\ndescription: versão atualizada para a conversa aberta\n---',
      'utf8'
    )

    await s.send('primeiro envio depois da mudança')
    expect(reloadSkills).toHaveBeenCalledTimes(1)
    expect(String(pushedMessages(s).at(-1)?.message.content)).toContain('[SKILL_CATALOG_UPDATE]')
    expect(String(pushedMessages(s).at(-1)?.message.content)).toContain(
      'Description: versão atualizada para a conversa aberta'
    )

    await s.send('catálogo não deve repetir')
    expect(reloadSkills).toHaveBeenCalledTimes(1)
    expect(String(pushedMessages(s).at(-1)?.message.content)).not.toContain('[SKILL_CATALOG_UPDATE]')

    await rm(skillDir, { recursive: true })
    await s.send('remoção também deve atualizar')
    expect(reloadSkills).toHaveBeenCalledTimes(2)
    const removalUpdate = String(pushedMessages(s).at(-1)?.message.content)
    expect(removalUpdate).toContain('[SKILL_CATALOG_UPDATE]')
    expect(removalUpdate).not.toContain('/dynamic')
  })

  it('mantém o catálogo antigo até a recarga nativa ser confirmada', async () => {
    const project = await mkdtemp(join(tmpdir(), 'agent-session-skill-retry-'))
    const home = join(project, 'home')
    const cache = join(project, 'cache')
    cacheState.dir = cache
    cacheState.skillsDir = join(cache, 'skills')
    const skillDir = join(project, '.claude', 'skills', 'retry')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: retry\ndescription: inicial\n---', 'utf8')
    const { s } = makeSession({
      cwd: project,
      model: 'gpt-6-sol',
      skillRuntime: { appRoot: project, userHome: home }
    })
    await s.start()
    await Promise.resolve()

    const loaded = { name: 'retry', description: 'retry', argumentHint: '' }
    const reloadSkills = vi
      .fn<() => Promise<{ skills: Array<typeof loaded> }>>()
      .mockRejectedValueOnce(new Error('falha transitória'))
      .mockResolvedValue({ skills: [loaded] })
    ;(s as unknown as { q: { reloadSkills: typeof reloadSkills } }).q = { reloadSkills }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: retry\ndescription: atualizada\n---', 'utf8')

    try {
      await s.send('primeira tentativa')
      await s.send('segunda tentativa')
    } finally {
      warning.mockRestore()
    }

    expect(reloadSkills).toHaveBeenCalledTimes(2)
    const messages = pushedMessages(s)
    expect(String(messages.at(-2)?.message.content)).toContain('[SKILL_CATALOG_UPDATE]')
    expect(String(messages.at(-2)?.message.content)).not.toContain('/retry')
    expect(String(messages.at(-1)?.message.content)).toContain('[SKILL_CATALOG_UPDATE]')
    expect(String(messages.at(-1)?.message.content)).toContain('Description: atualizada')
  })

  it('força recarga quando o conteúdo muda sem alterar tamanho nem timestamp', async () => {
    const project = await mkdtemp(join(tmpdir(), 'agent-session-skill-same-metadata-'))
    const home = join(project, 'home')
    const cache = join(project, 'cache')
    cacheState.dir = cache
    cacheState.skillsDir = join(cache, 'skills')
    const skillDir = join(project, '.agents', 'skills', 'stable-meta')
    const sourceFile = join(skillDir, 'SKILL.md')
    await mkdir(skillDir, { recursive: true })
    await writeFile(sourceFile, '---\nname: stable-meta\ndescription: igual\n---\nBODY_A', 'utf8')
    const original = await stat(sourceFile)
    const { s } = makeSession({
      cwd: project,
      model: 'gpt-6-sol',
      skillRuntime: { appRoot: project, userHome: home }
    })
    await s.start()

    const loaded = { name: 'stable-meta', description: 'igual', argumentHint: '' }
    const reloadSkills = vi
      .fn<() => Promise<{ skills: Array<typeof loaded> }>>()
      .mockResolvedValueOnce({ skills: [loaded] })
      .mockRejectedValueOnce(new Error('falha depois da cópia'))
      .mockResolvedValue({ skills: [loaded] })
    ;(s as unknown as { q: { reloadSkills: typeof reloadSkills } }).q = { reloadSkills }
    await s.send('confirme a versão inicial')

    await writeFile(sourceFile, '---\nname: stable-meta\ndescription: igual\n---\nBODY_B', 'utf8')
    await utimes(sourceFile, original.atime, original.mtime)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await s.send('primeira recarga falha')
      await s.send('repita mesmo com os metadados iguais')
    } finally {
      warning.mockRestore()
    }

    expect(reloadSkills).toHaveBeenCalledTimes(3)
    expect(await readFile(join(cache, 'skills', 'stable-meta', 'SKILL.md'), 'utf8')).toContain('BODY_B')
  })

  it('repete a recarga quando o SDK omite uma skill esperada', async () => {
    const project = await mkdtemp(join(tmpdir(), 'agent-session-skill-missing-'))
    const home = join(project, 'home')
    const cache = join(project, 'cache')
    cacheState.dir = cache
    cacheState.skillsDir = join(cache, 'skills')
    const skillDir = join(project, '.claude', 'skills', 'expected')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: expected\ndescription: inicial\n---', 'utf8')
    const { s } = makeSession({
      cwd: project,
      model: 'gpt-6-sol',
      skillRuntime: { appRoot: project, userHome: home }
    })
    await s.start()

    const loaded = { name: 'expected', description: 'expected', argumentHint: '' }
    const reloadSkills = vi
      .fn<() => Promise<{ skills: Array<typeof loaded> }>>()
      .mockResolvedValueOnce({ skills: [] })
      .mockResolvedValue({ skills: [loaded] })
    ;(s as unknown as { q: { reloadSkills: typeof reloadSkills } }).q = { reloadSkills }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: expected\ndescription: atualizada\n---', 'utf8')

    try {
      await s.send('registro ainda incompleto')
      await s.send('registro confirmado')
    } finally {
      warning.mockRestore()
    }

    expect(reloadSkills).toHaveBeenCalledTimes(2)
    const messages = pushedMessages(s)
    expect(String(messages.at(-2)?.message.content)).toContain('[SKILL_CATALOG_UPDATE]')
    expect(String(messages.at(-2)?.message.content)).not.toContain('/expected')
    expect(String(messages.at(-1)?.message.content)).toContain('[SKILL_CATALOG_UPDATE]')
  })

  it('skill instalada só em ~/.claude é importada para o cache e entra no catálogo junto com as outras', async () => {
    // `graphify` existe só em ~/.claude/skills (raiz que o CLI via SDK não lê):
    // o Agent Code a importa para o cache, que o SDK lê, e a anuncia com as demais.
    const project = await mkdtemp(join(tmpdir(), 'agent-session-skill-partial-'))
    const home = join(project, 'home')
    const cache = join(project, 'cache')
    cacheState.dir = cache
    cacheState.skillsDir = join(cache, 'skills')
    await mkdir(join(project, '.agents', 'skills', 'caveman'), { recursive: true })
    await writeFile(join(project, '.agents', 'skills', 'caveman', 'SKILL.md'), '---\nname: caveman\ndescription: terse\n---', 'utf8')
    const userOnly = join(home, '.claude', 'skills', 'graphify')
    await mkdir(userOnly, { recursive: true })
    await writeFile(join(userOnly, 'SKILL.md'), '---\nname: graphify\ndescription: grafo\n---', 'utf8')
    const { s } = makeSession({
      cwd: project,
      model: 'gpt-6-sol',
      skillRuntime: { appRoot: project, userHome: home }
    })
    await s.start()

    const reloadSkills = vi.fn(async () => ({
      skills: [
        { name: 'caveman', description: 'terse', argumentHint: '' },
        { name: 'graphify', description: 'grafo', argumentHint: '' }
      ]
    }))
    ;(s as unknown as { q: { reloadSkills: typeof reloadSkills } }).q = { reloadSkills }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await s.send('primeiro envio')
      await s.send('segundo envio')
    } finally {
      warning.mockRestore()
    }

    const first = String(pushedMessages(s).at(-2)?.message.content)
    expect(first).toContain('[SKILL_CATALOG_UPDATE]')
    expect(first).toContain('/caveman')
    expect(first).toContain('/graphify')
    expect(first).not.toContain('no filesystem skills')
    // Skill só do usuário não dispara re-recarga a cada mensagem.
    expect(reloadSkills).toHaveBeenCalledTimes(1)
    expect(String(pushedMessages(s).at(-1)?.message.content)).not.toContain('[SKILL_CATALOG_UPDATE]')
  })

  it('não injeta proxy nem limite GPT numa sessão Anthropic', async () => {
    const { s } = makeSession({ model: 'claude-sonnet-5' })
    await expect(s.start()).resolves.toBe(true)
    expect(optionsOfLastQuery().env).toBeUndefined()
    expect(optionsOfLastQuery().maxTurns).toBeUndefined()
    expect(ensureCodexProxyMock).not.toHaveBeenCalled()
  })

  it('falha antes de iniciar o SDK quando o ChatGPT está desconectado', async () => {
    codexState.connected = false
    const { s, emit } = makeSession({ model: 'gpt-6-luna' })
    await expect(s.start()).resolves.toBe(false)
    expect(queryMock).not.toHaveBeenCalled()
    expect(ensureCodexProxyMock).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', text: expect.stringMatching(/login/i) }))
  })
})

describe('AgentSession — carimbo de data/hora e máquina', () => {
  it('formata o carimbo do PC com data, hora, fuso e nome da máquina', () => {
    const stamp = buildContextStamp('pc', new Date(2026, 7, 4, 22, 31, 5), 'MATHEUS-NOTE')
    expect(stamp).toContain('do PC MATHEUS-NOTE')
    expect(stamp).toContain('04/08/2026')
    expect(stamp).toContain('22:31:05')
    expect(stamp).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('carimbo do celular deixa claro que veio pela ponte LAN', () => {
    const stamp = buildContextStamp('celular', new Date(2026, 7, 4, 22, 31, 5), 'MATHEUS-NOTE')
    expect(stamp).toContain('do celular, pela ponte LAN do PC MATHEUS-NOTE')
  })

  it('toda mensagem sai carimbada, com o texto do usuário preservado abaixo', async () => {
    const { s } = makeSession()
    await s.send('roda os testes')
    const content = pushedMessages(s).at(-1)!.message.content as string
    expect(content).toMatch(/^\[Contexto do sistema: mensagem enviada do PC /)
    expect(content.endsWith('\n\nroda os testes')).toBe(true)
  })

  it('origem celular muda o carimbo da mesma mensagem', async () => {
    const { s } = makeSession()
    await s.send('roda os testes', undefined, undefined, 'celular')
    expect(pushedMessages(s).at(-1)!.message.content as string).toContain('do celular')
  })

  // Mensagem só com imagem tinha texto vazio e ia sem nenhum bloco de texto —
  // o carimbo não pode sumir junto.
  it('mensagem sem texto ainda leva o carimbo', async () => {
    const { s } = makeSession()
    await s.send('', [{ mediaType: 'image/png', data: 'AAA' }])
    const blocks = pushedMessages(s).at(-1)!.message.content as Array<{ type: string; text?: string }>
    expect(blocks.at(-1)!.type).toBe('text')
    expect(blocks.at(-1)!.text).toContain('[Contexto do sistema:')
  })
})

describe('AgentSession — documentação do projeto em cada mensagem', () => {
  type ContextHook = (input: Record<string, unknown>) => Promise<{ hookSpecificOutput?: { additionalContext?: string } }>

  function requestHooks(): { user: ContextHook; postToolBatch: ContextHook } {
    const options = queryMock.mock.calls.at(-1)![0].options as {
      hooks: Record<string, Array<{ hooks: ContextHook[] }>>
    }
    return {
      user: options.hooks.UserPromptSubmit[0].hooks[0],
      postToolBatch: options.hooks.PostToolBatch[0].hooks[0]
    }
  }

  it('injeta docs frescos em cada request, sem gravá-los no histórico do usuário', async () => {
    projectOutlineMock
      .mockResolvedValueOnce('[PROJECT_DOCS_CONTEXT]\ndocs/\n  antes.md\n[/PROJECT_DOCS_CONTEXT]')
      .mockResolvedValueOnce('[PROJECT_DOCS_CONTEXT]\ndocs/\n  depois-da-ferramenta.md\n[/PROJECT_DOCS_CONTEXT]')
    const { s } = makeSession()
    await s.start()
    await s.send('use o guia')

    const persisted = pushedMessages(s).at(-1)!.message.content as string
    expect(persisted).toContain('use o guia')
    expect(persisted).not.toContain('[PROJECT_DOCS_CONTEXT]')

    const hooks = requestHooks()
    await expect(hooks.user({ hook_event_name: 'UserPromptSubmit' })).resolves.toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining('antes.md') }
    })
    await expect(hooks.postToolBatch({ hook_event_name: 'PostToolBatch' })).resolves.toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining('depois-da-ferramenta.md') }
    })
    expect(projectOutlineMock).toHaveBeenCalledTimes(2)
    expect(projectOutlineMock).toHaveBeenCalledWith('/proj')
  })

  it('falha do outline não bloqueia nem perde a mensagem e marca apenas o contexto vivo', async () => {
    projectOutlineMock.mockRejectedValueOnce(new Error('sem acesso'))
    const { s } = makeSession()
    await s.start()
    await s.send('continue mesmo assim')

    const persisted = pushedMessages(s).at(-1)!.message.content as string
    expect(persisted).not.toContain('context unavailable')
    expect(persisted.endsWith('\n\ncontinue mesmo assim')).toBe(true)
    await expect(requestHooks().user({ hook_event_name: 'UserPromptSubmit' })).resolves.toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining('context unavailable for this request') }
    })
  })

  it('não envia a documentação como pista para o relay de visão; o hook a injeta no request', async () => {
    describeImagesMock.mockResolvedValueOnce('descrição')
    projectOutlineMock.mockResolvedValueOnce('[PROJECT_DOCS_CONTEXT]\ndocs/\n  arquitetura.md\n[/PROJECT_DOCS_CONTEXT]')
    configState.ollama = { enabled: true, apiKey: 'synthetic' }
    const { s } = makeSession({ model: 'glm-5.3:cloud' })
    await s.start()
    await s.send('analise a tela', [{ mediaType: 'image/png', data: 'AAA' }])

    expect(describeImagesMock).toHaveBeenCalledWith(expect.any(Array), 'analise a tela')
    expect(pushedMessages(s).at(-1)!.message.content as string).not.toContain('arquitetura.md')
    await expect(requestHooks().user({ hook_event_name: 'UserPromptSubmit' })).resolves.toMatchObject({
      hookSpecificOutput: { additionalContext: expect.stringContaining('arquitetura.md') }
    })
  })
  // Reinício só pode ser recusado por trabalho que de fato não terminou. A regra
  // antiga era um latch: a 1ª chamada de Bash bloqueava o reinício pelo resto da
  // vida do processo, inclusive depois da conversa fechar.
  const OPAQUE = 'Trabalho autônomo sem prova de término.'
  describe('incerteza de reinício', () => {
    type Hook = (input: Record<string, unknown>) => Promise<unknown>
    function hooks(): { pre: Hook; post: Hook; fail: Hook } {
      const options = queryMock.mock.calls.at(-1)![0].options as {
        hooks: Record<string, Array<{ hooks: Hook[] }>>
      }
      return {
        pre: options.hooks.PreToolUse[0].hooks[0],
        post: options.hooks.PostToolUse[0].hooks[0],
        fail: options.hooks.PostToolUseFailure[0].hooks[0]
      }
    }
    async function started() {
      const session = makeSession()
      await session.s.start()
      return { ...session, ...hooks() }
    }
    const call = (name: string, id: string, input: unknown = {}) => ({
      hook_event_name: 'PreToolUse',
      tool_name: name,
      tool_use_id: id,
      tool_input: input
    })

    it('Bash em voo bloqueia; ao retornar, libera', async () => {
      const { s, pre, post } = await started()
      await pre(call('Bash', 'call-1'))
      expect(s.restartActivity().unsafe).toBe(OPAQUE)

      // Retornar É a prova de que a ferramenta terminou.
      await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call-1', tool_input: {}, tool_response: {} })
      expect(s.restartActivity().unsafe).not.toBe(OPAQUE)
    })

    it('erro da ferramenta também encerra a chamada', async () => {
      const { s, pre, fail } = await started()
      await pre(call('mcp__terceiro__coisa', 'call-2'))
      expect(s.restartActivity().unsafe).toBeDefined()

      await fail({ hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__terceiro__coisa', tool_use_id: 'call-2', tool_input: {}, error: 'quebrou' })
      expect(s.restartActivity().unsafe).not.toBe(OPAQUE)
    })

    it('várias chamadas em voo: libera só quando a última retorna', async () => {
      const { s, pre, post } = await started()
      await pre(call('Bash', 'a'))
      await pre(call('Bash', 'b'))
      await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'a', tool_input: {}, tool_response: {} })
      expect(s.restartActivity().unsafe).toBeDefined()

      await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_input: {}, tool_response: {} })
      expect(s.restartActivity().unsafe).not.toBe(OPAQUE)
    })

    it('ferramenta verificável nunca gera incerteza', async () => {
      const { s, pre } = await started()
      await pre(call('Read', 'call-3'))
      expect(s.restartActivity().unsafe).not.toBe(OPAQUE)
    })

    it('trabalho destacado continua incerto mesmo depois de retornar', async () => {
      const { s, pre, post } = await started()
      // run_in_background devolve na hora e segue rodando: o retorno não prova nada.
      await pre(call('Bash', 'bg', { run_in_background: true }))
      await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'bg', tool_input: { run_in_background: true }, tool_response: {} })
      expect(s.restartActivity().unsafe).toBe(OPAQUE)
    })

    it('cron destacado continua incerto', async () => {
      const { s, pre, post } = await started()
      await pre(call('CronCreate', 'cron'))
      await post({ hook_event_name: 'PostToolUse', tool_name: 'CronCreate', tool_use_id: 'cron', tool_input: {}, tool_response: {} })
      expect(s.restartActivity().unsafe).toBeDefined()
    })
  })

  // "Ocupado" sozinho não distingue trabalhando de travado. Aqui o relógio é
  // falso de propósito: esperar 60s de verdade tornaria o teste inútil.
  describe('detecção de turno travado', () => {
    type Hook = (input: Record<string, unknown>) => Promise<unknown>
    async function started(): Promise<ReturnType<typeof makeSession> & { prompt: Hook; pre: Hook; post: Hook }> {
      const session = makeSession()
      await session.s.start()
      const options = queryMock.mock.calls.at(-1)![0].options as {
        hooks: Record<string, Array<{ hooks: Hook[] }>>
      }
      return {
        ...session,
        prompt: options.hooks.UserPromptSubmit[0].hooks[0],
        pre: options.hooks.PreToolUse[0].hooks[0],
        post: options.hooks.PostToolUse[0].hooks[0]
      }
    }
    const stalls = (emit: ReturnType<typeof vi.fn>): unknown[] =>
      emit.mock.calls.map((c) => c[0]).filter((e: { kind?: string }) => e?.kind === 'stall-status')

    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('turno mudo além do limiar avisa uma vez só', async () => {
      const { emit, prompt } = await started()
      await prompt({ hook_event_name: 'UserPromptSubmit' })

      vi.advanceTimersByTime(STALL_THRESHOLD_MS - 1_000)
      expect(stalls(emit)).toHaveLength(0) // ainda dentro do normal

      vi.advanceTimersByTime(10_000)
      expect(stalls(emit)).toEqual([expect.objectContaining({ kind: 'stall-status', stalled: true })])

      // Continuar mudo não repete o aviso: o estado já é esse.
      vi.advanceTimersByTime(60_000)
      expect(stalls(emit)).toHaveLength(1)
    })

    it('trava ANTES do CLI processar o prompt também é detectada', async () => {
      // O pior travamento é o processo que nunca chega a processar a mensagem:
      // aí o hook UserPromptSubmit nunca dispara. Ligar o watchdog só no hook
      // fazia o recurso perder exatamente o caso que ele existe para pegar.
      const { s, emit } = await started()
      await s.send('oi')

      vi.advanceTimersByTime(STALL_THRESHOLD_MS + 5_000)
      expect(stalls(emit)).toEqual([expect.objectContaining({ stalled: true })])
    })

    it('conversa parada nunca é acusada de travada', async () => {
      const { emit } = await started()
      // Sem turno em andamento o silêncio é o estado normal, não uma falha.
      vi.advanceTimersByTime(STALL_THRESHOLD_MS * 3)
      expect(stalls(emit)).toHaveLength(0)
    })

    it('ferramenta em voo tolera minutos de silêncio', async () => {
      const { emit, prompt, pre } = await started()
      await prompt({ hook_event_name: 'UserPromptSubmit' })
      // Um build legítimo passa minutos sem emitir nada — acusar aqui seria
      // falso positivo, que é o que desqualifica um aviso desses.
      await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'build', tool_input: {} })

      vi.advanceTimersByTime(STALL_THRESHOLD_MS * 2)
      expect(stalls(emit)).toHaveLength(0)

      vi.advanceTimersByTime(STALL_THRESHOLD_TOOL_MS)
      expect(stalls(emit)).toEqual([expect.objectContaining({ stalled: true })])
    })

    it('ferramenta que retorna volta ao limiar curto', async () => {
      const { emit, prompt, pre, post } = await started()
      await prompt({ hook_event_name: 'UserPromptSubmit' })
      await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: {} })
      await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'x', tool_input: {}, tool_response: {} })

      vi.advanceTimersByTime(STALL_THRESHOLD_MS + 5_000)
      expect(stalls(emit)).toEqual([expect.objectContaining({ stalled: true })])
    })

    type CanUse = (
      name: string,
      input: Record<string, unknown>,
      opts: { signal: AbortSignal; toolUseID: string }
    ) => Promise<{ behavior: string }>
    const canUseToolOf = (): CanUse => (queryMock.mock.calls.at(-1)![0].options as { canUseTool: CanUse }).canUseTool
    const inFlightOf = (s: AgentSession): { toolsInFlight: Set<string>; restartOpaqueCalls: Set<string> } =>
      s as unknown as { toolsInFlight: Set<string>; restartOpaqueCalls: Set<string> }

    it('ferramenta negada no canUseTool sai do registro em voo (o SDK não manda Post* para ela)', async () => {
      const { s, emit, prompt, pre } = await started()
      const inFlight = inFlightOf(s)
      await prompt({ hook_event_name: 'UserPromptSubmit' })
      await pre({ hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_use_id: 'negada', tool_input: { skill: 'loop' } })
      expect(inFlight.toolsInFlight.has('negada')).toBe(true)
      expect(inFlight.restartOpaqueCalls.has('negada')).toBe(true)

      // Loop desligado nesta conversa: o gate nega.
      const res = await canUseToolOf()('Skill', { skill: 'loop' }, { signal: new AbortController().signal, toolUseID: 'negada' })
      expect(res.behavior).toBe('deny')
      expect(inFlight.toolsInFlight.has('negada')).toBe(false)
      expect(inFlight.restartOpaqueCalls.has('negada')).toBe(false)
      // Sem nada em voo, o limiar curto volta a valer (antes ficava o de ferramenta, para sempre).
      vi.advanceTimersByTime(STALL_THRESHOLD_MS + 5_000)
      expect(stalls(emit)).toEqual([expect.objectContaining({ stalled: true })])
    })

    it('ferramenta aprovada no canUseTool segue em voo até retornar', async () => {
      const { s, pre } = await started()
      s.setBypass(true)
      await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'ok', tool_input: { command: 'ls' } })
      const res = await canUseToolOf()('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'ok' })
      expect(res.behavior).toBe('allow')
      expect(inFlightOf(s).toolsInFlight.has('ok')).toBe(true)
      expect(inFlightOf(s).restartOpaqueCalls.has('ok')).toBe(true)
    })

    it('sinal de vida desfaz o aviso', async () => {
      const { s, emit, prompt } = await started()
      await prompt({ hook_event_name: 'UserPromptSubmit' })
      vi.advanceTimersByTime(STALL_THRESHOLD_MS + 5_000)
      expect(stalls(emit)).toHaveLength(1)

      // Qualquer mensagem do SDK conta, inclusive um delta de streaming.
      ;(s as unknown as { handleMessage: (m: unknown) => void }).handleMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'oi' } }
      })
      expect(stalls(emit).at(-1)).toEqual(expect.objectContaining({ stalled: false }))
    })

    it('descartar a sessão não deixa o intervalo emitindo', async () => {
      const { s, emit, prompt } = await started()
      await prompt({ hook_event_name: 'UserPromptSubmit' })
      s.dispose()

      vi.advanceTimersByTime(STALL_THRESHOLD_MS * 3)
      // Um evento depois do dispose seria de uma conversa que não existe mais.
      expect(stalls(emit)).toHaveLength(0)
    })
  })
  // O usuário quer a senha no prompt, mas só quando ele marca a opção. O
  // interruptor é a única coisa entre o cofre e a janela do modelo.
  describe('senhas do cofre no prompt', () => {
    function appended(): string {
      const options = queryMock.mock.calls.at(-1)![0].options as {
        systemPrompt: { append: string }
      }
      return options.systemPrompt.append
    }

    it('injeta as senhas em texto puro quando a opção está ligada', async () => {
      secretsForPrompt.mockResolvedValue([
        { name: 'banco-prod', value: 'senha-real-123' },
        { name: 'smtp', value: 'outra-senha' }
      ])
      const { s } = makeSession()
      await s.start()

      const append = appended()
      expect(append).toContain('banco-prod: senha-real-123')
      expect(append).toContain('smtp: outra-senha')
      // Não basta entregar o valor: o modelo precisa saber que é segredo.
      expect(append).toContain('# Senhas do cofre')
    })

    it('não injeta nada quando o cofre está desligado ou vazio', async () => {
      secretsForPrompt.mockResolvedValue([])
      const { s } = makeSession()
      await s.start()

      expect(appended()).not.toContain('# Senhas do cofre')
    })

    it('falha na leitura do cofre não impede a sessão de iniciar', async () => {
      // Cofre indisponível degrada o turno; travar a abertura da conversa seria pior.
      secretsForPrompt.mockRejectedValue(new Error('cofre indisponível'))
      const { s } = makeSession()

      await expect(s.start()).resolves.not.toThrow()
      expect(appended()).not.toContain('# Senhas do cofre')
    })
  })
})

describe('AgentSession — projetos conhecidos nesta máquina', () => {
  it('injeta nome + caminho de cada projeto no primeiro envio, e não repete quando nada muda', async () => {
    projectsState.list = [
      { cwd: '/proj', total: 3, updatedAt: '2026-09-22T10:00:00.000Z' },
      { cwd: '/outro/projeto-b', total: 1, updatedAt: '2026-09-22T09:00:00.000Z' }
    ]
    const { s } = makeSession()
    await s.start()

    await s.send('oi')
    await s.send('de novo')

    const first = String(pushedMessages(s).at(-2)?.message.content)
    const second = String(pushedMessages(s).at(-1)?.message.content)
    expect(first).toContain('[PROJECTS_ON_THIS_MACHINE]')
    expect(first).toContain('proj — /proj')
    expect(first).toContain('projeto-b — /outro/projeto-b')
    expect(first).toContain('THIS machine')
    expect(second).not.toContain('[PROJECTS_ON_THIS_MACHINE]')
  })

  it('reaparece quando um projeto novo entra na lista', async () => {
    projectsState.list = [{ cwd: '/proj', total: 1, updatedAt: '2026-09-22T10:00:00.000Z' }]
    const { s } = makeSession()
    await s.start()
    await s.send('primeiro')

    projectsState.list = [
      { cwd: '/proj', total: 1, updatedAt: '2026-09-22T10:00:00.000Z' },
      { cwd: '/novo-projeto', total: 1, updatedAt: '2026-09-22T11:00:00.000Z' }
    ]
    await s.send('segundo')

    expect(String(pushedMessages(s).at(-1)?.message.content)).toContain('novo-projeto — /novo-projeto')
  })

  it('lista vazia (sem conversas ainda) não injeta nada', async () => {
    projectsState.list = []
    const { s } = makeSession()
    await s.start()
    await s.send('oi')

    expect(String(pushedMessages(s).at(-1)?.message.content)).not.toContain('[PROJECTS_ON_THIS_MACHINE]')
  })
})

describe('AgentSession — o TypeSafe escolhe as memórias do turno', () => {
  type ContextHook = (input: Record<string, unknown>) => Promise<{ hookSpecificOutput?: { additionalContext?: string } }>

  function requestHooks(): { user: ContextHook; postToolBatch: ContextHook } {
    const options = queryMock.mock.calls.at(-1)![0].options as {
      hooks: Record<string, Array<{ hooks: ContextHook[] }>>
    }
    return {
      user: options.hooks.UserPromptSubmit[0].hooks[0],
      postToolBatch: options.hooks.PostToolBatch[0].hooks[0]
    }
  }

  async function liveContext(hook: ContextHook, event: string): Promise<string> {
    return (await hook({ hook_event_name: event })).hookSpecificOutput?.additionalContext ?? ''
  }

  function appendedSystemPrompt(): string {
    const options = queryMock.mock.calls.at(-1)![0].options as { systemPrompt: { append: string } }
    return options.systemPrompt.append
  }

  /** Pasta de memórias real, para o caminho lexical de fallback ter o que achar. */
  async function memoriesFixture(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'agent-session-typesafe-'))
    await writeFile(join(dir, 'MEMORY.md'), '# Índice\n\n- [ERP](erp.md) — o ERP da 2D\n', 'utf8')
    await writeFile(join(dir, 'erp.md'), '---\ndescription: o ERP da 2D\n---\n# ERP\nO banco chama FALCAO.\n', 'utf8')
    cacheState.memoriesDir = dir
    return dir
  }

  it('decide UMA vez por mensagem, não a cada volta do loop de ferramentas', async () => {
    typeSafeState.active = true
    typeSafeState.selection = { block: '--- Memória relevante: erp.md ---\nO banco chama FALCAO.', relPaths: ['erp.md'] }
    const { s } = makeSession()
    await s.start()
    await s.send('e o ERP?')

    const hooks = requestHooks()
    const contexts = [
      await liveContext(hooks.user, 'UserPromptSubmit'),
      await liveContext(hooks.postToolBatch, 'PostToolBatch'),
      await liveContext(hooks.postToolBatch, 'PostToolBatch')
    ]

    expect(typeSafeState.queries).toHaveLength(1)
    for (const context of contexts) expect(context).toContain('O banco chama FALCAO.')

    await s.send('e agora?')
    await liveContext(requestHooks().postToolBatch, 'PostToolBatch')
    expect(typeSafeState.queries).toEqual(['e o ERP?', 'e agora?'])
  })

  it('com o seletor no ar, catálogo e atualização de catálogo somem do prompt', async () => {
    await memoriesFixture()
    typeSafeState.active = true
    typeSafeState.selection = { block: '--- Memória relevante: erp.md ---\nO banco chama FALCAO.', relPaths: ['erp.md'] }
    const { s } = makeSession()
    await s.start()

    const append = appendedSystemPrompt()
    expect(append).not.toContain('AUTHORITATIVE PERSISTENT MEMORY CATALOG')
    // O cabeçalho de memória NÃO escolhida não pode vazar por caminho nenhum.
    expect(append).not.toContain('- [ERP](erp.md) — o ERP da 2D')

    await s.send('e o ERP?')
    const persisted = String(pushedMessages(s).at(-1)!.message.content)
    expect(persisted).not.toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(persisted).not.toContain('- [ERP](erp.md) — o ERP da 2D')

    const live = await liveContext(requestHooks().user, 'UserPromptSubmit')
    expect(live).toContain('--- Memória relevante: erp.md ---')
    expect(live).not.toContain('MEMORY.md (índice da raiz)')
  })

  it('ZERO memórias escolhidas significa prompt sem memória — sem compensar pelo caminho lexical', async () => {
    await memoriesFixture()
    typeSafeState.active = true
    typeSafeState.selection = { block: '', relPaths: [] }
    const { s } = makeSession()
    await s.start()
    await s.send('oi')

    const live = await liveContext(requestHooks().user, 'UserPromptSubmit')
    expect(live).not.toContain('Memória relevante')
    expect(live).not.toContain('FALCAO')
    expect(live).toContain('[PROJECT_DOCS_CONTEXT]')
  })

  it('desligado ou sem chave: catálogo e excertos lexicais voltam intactos', async () => {
    await memoriesFixture()
    typeSafeState.active = false
    typeSafeState.selection = null
    const { s } = makeSession()
    await s.start()
    await s.send('me lembra do ERP')

    const append = appendedSystemPrompt()
    expect(append).toContain('AUTHORITATIVE PERSISTENT MEMORY CATALOG')
    expect(append).toContain('- [ERP](erp.md) — o ERP da 2D')

    const live = await liveContext(requestHooks().user, 'UserPromptSubmit')
    expect(live).toContain('--- Memória relevante: erp.md ---')
    expect(live).toContain('FALCAO')
  })

  it('timeout ou erro na decisão mantém o fallback lexical vivo', async () => {
    await memoriesFixture()
    // Catálogo suprimido na abertura (havia chave), decisão indisponível na hora:
    // o turno não fica sem memória — o caminho lexical assume.
    typeSafeState.active = true
    typeSafeState.selection = null
    const { s } = makeSession()
    await s.start()
    await s.send('me lembra do ERP')

    const live = await liveContext(requestHooks().user, 'UserPromptSubmit')
    expect(live).toContain('--- Memória relevante: erp.md ---')
    expect(live).toContain('FALCAO')
  })

  it('desligar o recurso no meio da conversa devolve o catálogo completo no despacho seguinte', async () => {
    await memoriesFixture()
    typeSafeState.active = true
    typeSafeState.selection = { block: '', relPaths: [] }
    const { s } = makeSession()
    await s.start()
    await s.send('primeira')
    expect(String(pushedMessages(s).at(-1)!.message.content)).not.toContain('[PERSISTENT_MEMORY_UPDATE]')

    typeSafeState.active = false
    typeSafeState.selection = null
    await s.send('segunda')

    const persisted = String(pushedMessages(s).at(-1)!.message.content)
    expect(persisted).toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(persisted).toContain('- [ERP](erp.md) — o ERP da 2D')
  })

  /**
   * Integração de ponta a ponta do registro de memórias usadas: seletor real,
   * sessão real, registro real. A única coisa falsa é a resposta do serviço.
   *
   * Nada de `usedMemories` injetado — é a MESMA função exportada que `index.ts`
   * entrega ao memorista. Sem isto, o gate lia `[]` para sempre e ninguém via.
   */
  describe('o que foi escolhido chega ao gate do memorista', () => {
    /** Duas memórias: dá para trocar a escolha entre um turno e o seguinte. */
    async function acervo(): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'agent-session-usadas-'))
      await writeFile(join(dir, 'MEMORY.md'), '# Índice\n\n- [ERP](erp.md) — o ERP da 2D\n', 'utf8')
      await writeFile(join(dir, 'erp.md'), '---\ndescription: o ERP da 2D\n---\n# ERP\nO banco chama FALCAO.\n', 'utf8')
      await writeFile(join(dir, 'nota.md'), '---\ndescription: nota fiscal\n---\n# Nota\nEmitir pela SEFAZ.\n', 'utf8')
      cacheState.memoriesDir = dir
      typeSafeState.active = true
      typeSafeState.passthrough = true
      return dir
    }

    /** O que o gate do memorista veria neste momento para esta conversa. */
    function gateVeria(convId: string): string[] {
      return buildMemoryGateState({ userText: 'qualquer', usedMemories: usedMemories(convId) })
        .memorias_usadas_neste_turno
    }

    it('o gate recebe os relPath do turno — não uma lista vazia', async () => {
      await acervo()
      typeSafeService.probabilities = { 'erp.md': 0.9, 'nota.md': 0.1 }
      const { s } = makeSession()
      await s.start()
      await s.send('e o ERP?')

      // O prompt do turno recebeu a memória de verdade...
      const live = await liveContext(requestHooks().user, 'UserPromptSubmit')
      expect(live).toContain('--- Memória relevante: erp.md ---')
      expect(live).toContain('FALCAO')
      // ...e o gate enxerga exatamente essa memória.
      expect(usedMemories('c1')).toEqual(['erp.md'])
      expect(gateVeria('c1')).toEqual(['erp.md'])
    })

    it('a lista do turno SUBSTITUI a do turno anterior da mesma conversa', async () => {
      await acervo()
      typeSafeService.probabilities = { 'erp.md': 0.9, 'nota.md': 0.1 }
      const { s } = makeSession()
      await s.start()
      await s.send('e o ERP?')
      await liveContext(requestHooks().user, 'UserPromptSubmit')
      expect(usedMemories('c1')).toEqual(['erp.md'])

      typeSafeService.probabilities = { 'erp.md': 0.1, 'nota.md': 0.9 }
      await s.send('e a nota?')
      await liveContext(requestHooks().user, 'UserPromptSubmit')

      // Acumular faria o gate ver memória que não está no prompt DESTE turno.
      expect(usedMemories('c1')).toEqual(['nota.md'])
    })

    it('ZERO memórias escolhidas grava lista vazia, sem lançar', async () => {
      await acervo()
      // Nenhuma bate o limiar: decisão legítima de não injetar memória alguma.
      typeSafeService.probabilities = { 'erp.md': 0.4, 'nota.md': 0.4 }
      const { s } = makeSession()
      await s.start()
      await s.send('oi')

      const live = await liveContext(requestHooks().user, 'UserPromptSubmit')
      expect(live).not.toContain('Memória relevante')
      expect(usedMemories('c1')).toEqual([])
      expect(gateVeria('c1')).toEqual([])
    })

    it('sem decisão do TypeSafe o registro fica vazio e o gate segue de pé', async () => {
      await acervo()
      // `null` do serviço: timeout, sem chave, erro. O turno cai no caminho
      // lexical, e o que foi injetado por ali não é escolha registrada.
      typeSafeService.probabilities = null
      const { s } = makeSession()
      await s.start()
      await s.send('me lembra do ERP')

      const live = await liveContext(requestHooks().user, 'UserPromptSubmit')
      expect(live).toContain('FALCAO')
      expect(usedMemories('c1')).toEqual([])
      expect(gateVeria('c1')).toEqual([])
    })

    it('o fim da conversa limpa o registro — nada vaza para a conversa seguinte', async () => {
      await acervo()
      typeSafeService.probabilities = { 'erp.md': 0.9, 'nota.md': 0.1 }
      const { s } = makeSession()
      await s.start()
      await s.send('e o ERP?')
      await liveContext(requestHooks().user, 'UserPromptSubmit')
      expect(usedMemories('c1')).toEqual(['erp.md'])

      s.dispose()

      expect(usedMemories('c1')).toEqual([])
    })

    /**
     * A corrida de verdade: a decisão do turno N chegando DEPOIS de o turno N+1
     * já ter gravado a dele. Aqui a ordem de resolução é do teste, não do
     * relógio — cada chamada ao seletor devolve uma promessa parada até o teste
     * mandar resolver. Sem a guarda `selectionTurn === this.memorySelectionTurn`
     * a decisão atrasada escreve por cima e o gate julga um turno com as
     * memórias de outra mensagem.
     */
    describe('decisão em voo (corrida do ordinal)', () => {
      /** Drena as microtasks pendentes: setImmediate roda depois de todas. */
      const drenar = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

      const decisao = (relPath: string): { block: string; relPaths: string[] } => ({
        block: `--- Memória relevante: ${relPath} ---\nconteúdo`,
        relPaths: [relPath]
      })

      function avisosDeDegradacao(emit: ReturnType<typeof vi.fn>): unknown[] {
        return emit.mock.calls
          .map((c) => c[0])
          .filter((e: { text?: string }) => typeof e?.text === 'string' && e.text.includes('decisão indisponível'))
      }

      beforeEach(() => {
        typeSafeState.active = true
        typeSafeState.emVoo = []
      })

      it('decisão ATRASADA do turno anterior não escreve por cima da lista do turno mais novo', async () => {
        const { s } = makeSession()
        await s.start()
        await s.send('e o ERP?')
        await s.send('e a nota?')
        // Duas decisões em voo, nenhuma resolvida: nada foi gravado ainda.
        const [resolveTurno1, resolveTurno2] = typeSafeState.emVoo!
        expect(typeSafeState.emVoo).toHaveLength(2)
        expect(usedMemories('c1')).toEqual([])

        // O turno mais novo resolve primeiro e grava.
        resolveTurno2(decisao('nota.md'))
        await drenar()
        expect(usedMemories('c1')).toEqual(['nota.md'])

        // E só então chega a decisão do turno velho.
        resolveTurno1(decisao('erp.md'))
        await drenar()
        expect(usedMemories('c1')).toEqual(['nota.md'])
        expect(gateVeria('c1')).toEqual(['nota.md'])
      })

      it('decisão ATRASADA e VAZIA do turno anterior não apaga a lista do turno mais novo', async () => {
        const { s } = makeSession()
        await s.start()
        await s.send('e o ERP?')
        await s.send('e a nota?')
        const [resolveTurno1, resolveTurno2] = typeSafeState.emVoo!

        resolveTurno2(decisao('nota.md'))
        await drenar()
        // `null` grava lista VAZIA quando é do turno corrente — aqui é do velho,
        // então não pode zerar o que o turno novo já decidiu.
        resolveTurno1(null)
        await drenar()
        expect(usedMemories('c1')).toEqual(['nota.md'])
      })

      it('decisão ATRASADA de turno superado não emite o aviso de degradação', async () => {
        const { s, emit } = makeSession()
        await s.start()
        await s.send('e o ERP?')
        await s.send('e a nota?')
        const [resolveTurno1, resolveTurno2] = typeSafeState.emVoo!

        resolveTurno1(null)
        await drenar()
        expect(avisosDeDegradacao(emit)).toHaveLength(0)

        // Contraprova: a mesma ausência de decisão, agora no turno CORRENTE,
        // avisa — o silêncio acima é da guarda, não de o aviso estar morto.
        resolveTurno2(null)
        await drenar()
        expect(avisosDeDegradacao(emit)).toHaveLength(1)
      })

      it('dispose() com decisão em voo: o que chega depois não repovoa o registro', async () => {
        const { s } = makeSession()
        await s.start()
        await s.send('e o ERP?')
        const [resolveTurno1] = typeSafeState.emVoo!

        s.dispose()
        expect(usedMemories('c1')).toEqual([])

        // A conversa morreu; a decisão que chega depois não pode ressuscitar o
        // registro dela — seria vazamento por conversa morta.
        resolveTurno1(decisao('erp.md'))
        await drenar()
        expect(usedMemories('c1')).toEqual([])
      })

      it('dispose() com decisão em voo: nenhum aviso de degradação após o fim', async () => {
        const { s, emit } = makeSession()
        await s.start()
        await s.send('e o ERP?')
        const [resolveTurno1] = typeSafeState.emVoo!

        s.dispose()
        resolveTurno1(null)
        await drenar()
        expect(avisosDeDegradacao(emit)).toHaveLength(0)
      })
    })
  })
})

// docs/superpowers/specs/2026-09-19-arvore-consumo-tokens-design.md — cada
// mensagem `assistant` vira uma linha `llm_calls`/`ChatEvent('llm-call')`,
// atribuída ao nó (raiz do turno ou subagente) que a originou.
describe('AgentSession — árvore de consumo de tokens (llm-call)', () => {
  const turnIdOf = (s: AgentSession): string => (s as unknown as { getTurnId(): string }).getTurnId()

  const assistantMsg = (overrides: {
    parent_tool_use_id: string | null
    content: unknown[]
    subagent_type?: string
    task_description?: string
    usage?: Record<string, number>
    model?: string
  }): Record<string, unknown> => ({
    type: 'assistant',
    parent_tool_use_id: overrides.parent_tool_use_id,
    ...(overrides.subagent_type ? { subagent_type: overrides.subagent_type } : {}),
    ...(overrides.task_description ? { task_description: overrides.task_description } : {}),
    message: {
      model: overrides.model ?? 'claude-sonnet-5',
      usage: overrides.usage ?? {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 2
      },
      content: overrides.content
    }
  })

  const llmCallEvents = (emit: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> =>
    emit.mock.calls.map((c) => c[0]).filter((e) => (e as { kind?: string }).kind === 'llm-call')

  it('agente principal: node_id = turnId, parent_node_id = null', () => {
    const { s, emit } = makeSession()
    const turnId = turnIdOf(s)
    handle(
      s,
      assistantMsg({ parent_tool_use_id: null, content: [{ type: 'text', text: 'oi' }] })
    )
    const calls = llmCallEvents(emit)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      kind: 'llm-call',
      node_id: turnId,
      parent_node_id: null,
      seq: 1,
      model: 'claude-sonnet-5',
      tokens: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2 },
      outputPreview: 'oi'
    })
  })

  it('grava via o repositório ativo quando injetado', () => {
    const insertLlmCall = vi.fn(async () => ({}) as never)
    const { s } = makeSession({ tokenUsageRepository: { insertLlmCall } })
    const turnId = turnIdOf(s)
    handle(s, assistantMsg({ parent_tool_use_id: null, content: [{ type: 'text', text: 'oi' }] }))
    expect(insertLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        convId: 'c1',
        turnId,
        nodeId: turnId,
        parentNodeId: null,
        seq: 1,
        model: 'claude-sonnet-5',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 1,
        cacheWriteTokens: 2
      })
    )
  })

  it('corrige a chamada persistida com modelUsage no resultado terminal', async () => {
    const insertLlmCall = vi.fn(async () => ({ id: 'llm-call-1' }) as never)
    const updateLlmCall = vi.fn(async () => null)
    const { s } = makeSession({ tokenUsageRepository: { insertLlmCall, updateLlmCall } })
    const turnId = turnIdOf(s)
    handle(s, assistantMsg({ parent_tool_use_id: null, content: [{ type: 'text', text: 'oi' }] }))
    await Promise.resolve()
    handle(s, { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, modelUsage: {
      'claude-sonnet-5': { inputTokens: 40, outputTokens: 50, cacheReadInputTokens: 6, cacheCreationInputTokens: 7 }
    } })
    await Promise.resolve()
    expect(updateLlmCall).toHaveBeenCalledWith('llm-call-1', {
      inputTokens: 40,
      outputTokens: 50,
      cacheReadTokens: 6,
      cacheWriteTokens: 7
    })
    expect(insertLlmCall).toHaveBeenCalledWith(expect.objectContaining({ nodeId: turnId, seq: 1 }))
  })

  it('subagente de 1 nível: node_id = tool-use do Task, parent_node_id = turnId', () => {
    const { s, emit } = makeSession()
    const turnId = turnIdOf(s)
    // O agente principal delega a um subagente via a ferramenta "Task".
    handle(
      s,
      assistantMsg({
        parent_tool_use_id: null,
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: { description: 'explorar' } }]
      })
    )
    // O subagente responde: sua mensagem chega com parent_tool_use_id = id do Task.
    handle(
      s,
      assistantMsg({
        parent_tool_use_id: 'toolu_1',
        subagent_type: 'Explore',
        task_description: 'procurar X',
        content: [{ type: 'text', text: 'achei' }]
      })
    )
    const calls = llmCallEvents(emit)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatchObject({
      kind: 'llm-call',
      node_id: 'toolu_1',
      parent_node_id: turnId,
      seq: 1,
      subagentType: 'Explore',
      taskDescription: 'procurar X',
      outputPreview: 'achei'
    })
  })

  it('subagente de subagente (2+ níveis): parent_node_id encadeia através dos Task tool-use', () => {
    const { s, emit } = makeSession()
    const turnId = turnIdOf(s)
    // Agente principal delega ao subagente A.
    handle(
      s,
      assistantMsg({
        parent_tool_use_id: null,
        content: [{ type: 'tool_use', id: 'toolu_A', name: 'Task', input: {} }]
      })
    )
    // Subagente A, por sua vez, delega ao subagente B.
    handle(
      s,
      assistantMsg({
        parent_tool_use_id: 'toolu_A',
        subagent_type: 'Explore',
        content: [{ type: 'tool_use', id: 'toolu_B', name: 'Agent', input: {} }]
      })
    )
    // Subagente B responde.
    handle(
      s,
      assistantMsg({
        parent_tool_use_id: 'toolu_B',
        subagent_type: 'general-purpose',
        content: [{ type: 'text', text: 'pronto' }]
      })
    )
    const calls = llmCallEvents(emit)
    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({ node_id: turnId, parent_node_id: null })
    expect(calls[1]).toMatchObject({ node_id: 'toolu_A', parent_node_id: turnId })
    expect(calls[2]).toMatchObject({ node_id: 'toolu_B', parent_node_id: 'toolu_A' })
  })

  it('inputPreview vem do tool_result anterior do mesmo nó', () => {
    const { s, emit } = makeSession()
    // Subagente abre.
    handle(
      s,
      assistantMsg({ parent_tool_use_id: null, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} }] })
    )
    // Um tool_result chega para o nó do subagente antes da resposta dele.
    handle(s, {
      type: 'user',
      parent_tool_use_id: 'toolu_1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'conteúdo do arquivo' }] }
    })
    handle(s, assistantMsg({ parent_tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }] }))
    const calls = llmCallEvents(emit)
    const subagentCall = calls.find((c) => c.node_id === 'toolu_1')
    expect(subagentCall).toMatchObject({ inputPreview: 'conteúdo do arquivo' })
  })
})
