// @vitest-environment node
// Main-process code: pulls in node builtins (via config → store → node:sqlite),
// so it must run in the node env, not the default jsdom (which can't externalize
// the newer node:sqlite builtin and tries to bundle it).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const configState = vi.hoisted(() => ({ windowsControlEnabled: false as unknown }))
const codexState = vi.hoisted(() => ({ connected: true }))
const cacheState = vi.hoisted(() => ({
  dir: 'C:\\test\\agent-code',
  memoriesDir: 'C:\\test\\agent-code\\memories',
  skillsDir: 'C:\\test\\agent-code\\skills'
}))
const ensureCodexProxyMock = vi.hoisted(() =>
  vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:43210', secret: 'local-test-secret' }))
)
vi.mock('./config', () => ({
  loadConfig: () => ({
    windowsControlEnabled: configState.windowsControlEnabled,
    // start() reads these two; the permission-gate tests never call start(), but
    // the fast-mode test below does.
    ollama: { enabled: false, apiKey: '' }
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
const projectOutlineMock = vi.hoisted(() => vi.fn(async () => '[PROJECT_DOCS_CONTEXT]\ndocs/\n[/PROJECT_DOCS_CONTEXT]'))
vi.mock('./projectOutline', () => ({ buildProjectOutline: projectOutlineMock }))

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
  const { skillRuntime, ...agentOpts } = opts
  const s = new AgentSession(
    { convId: 'c1', cwd: '/proj', ...agentOpts },
    browser,
    emit,
    ask,
    expire,
    undefined,
    undefined,
    skillRuntime
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
  codexState.connected = true
  cacheState.dir = 'C:\\test\\agent-code'
  cacheState.memoriesDir = 'C:\\test\\agent-code\\memories'
  cacheState.skillsDir = 'C:\\test\\agent-code\\skills'
  queryMock.mockClear()
  ensureCodexProxyMock.mockClear()
  projectOutlineMock.mockReset()
  projectOutlineMock.mockResolvedValue('[PROJECT_DOCS_CONTEXT]\ndocs/\n[/PROJECT_DOCS_CONTEXT]')
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

  it.each(['claude-opus-4-8', 'gpt-5.6-luna'])(
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

  it.each(['claude-opus-4-8', 'gpt-5.6-luna'])(
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
    // O texto recebe carimbo, documentação e a atualização inicial sem passar pelo relay.
    const content = msg.message.content as string
    expect(content).toContain('[PROJECT_DOCS_CONTEXT]\ndocs/\n[/PROJECT_DOCS_CONTEXT]')
    expect(content).toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(content).toContain('só texto, sem imagem')
  })
})

describe('AgentSession — modo rápido (settings.fastMode) enviado ao SDK', () => {
  const optionsOfLastQuery = (): Record<string, unknown> =>
    (queryMock.mock.calls.at(-1)?.[0] as { options: Record<string, unknown> }).options

  beforeEach(() => queryMock.mockClear())

  it('modelo suportado + flag ligada: manda settings.fastMode', async () => {
    const { s } = makeSession({ model: 'claude-opus-5', fastMode: true })
    await s.start()
    expect(optionsOfLastQuery().settings).toEqual({ fastMode: true })
  })

  it('flag desligada: não manda settings (fica no padrão da conta)', async () => {
    const { s } = makeSession({ model: 'claude-opus-5', fastMode: false })
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
    const { s } = makeSession({ model: 'gpt-5.6-sol', fastMode: true })
    await s.start()
    const options = optionsOfLastQuery()
    expect(options.settings).toBeUndefined()
    expect((options.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toMatch(/\+fast$/)
  })

  it('GPT + flag desligada: token do proxy sai sem o sufixo', async () => {
    const { s } = makeSession({ model: 'gpt-5.6-sol', fastMode: false })
    await s.start()
    const options = optionsOfLastQuery()
    expect(options.settings).toBeUndefined()
    expect((options.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).not.toMatch(/\+fast$/)
  })
})

describe('AgentSession — GPT mantém o mesmo harness do Claude', () => {
  const optionsOfLastQuery = (): Record<string, unknown> =>
    (queryMock.mock.calls.at(-1)?.[0] as { options: Record<string, unknown> }).options

  it('preserva ferramentas/permissões e fixa todos os subagentes no GPT selecionado', async () => {
    const { s } = makeSession({ model: 'gpt-5.6-sol', effort: 'max' })
    await s.start()

    const options = optionsOfLastQuery()
    const env = options.env as Record<string, string>
    expect(options).toMatchObject({
      cwd: '/proj',
      model: 'gpt-5.6-sol',
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
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.6-sol',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'gpt-5.6-sol',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'gpt-5.6-sol',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'gpt-5.6-sol',
      CLAUDE_CODE_SUBAGENT_MODEL: 'gpt-5.6-sol'
    })
  })

  it('expõe a pasta de skills do cache ao GPT mesmo quando a conversa usa outro projeto', async () => {
    const { s } = makeSession({ model: 'gpt-5.6-sol', cwd: 'C:\\outro-projeto-sem-skills' })
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
      model: 'gpt-5.6-sol',
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

  it('envia todas as memórias uma vez no system prompt inicial', async () => {
    const memories = await mkdtemp(join(tmpdir(), 'agent-session-memory-start-'))
    await mkdir(join(memories, 'produto'))
    await writeFile(join(memories, 'MEMORY.md'), '# Índice\n\n- [Preferência](produto/preferencia.md)', 'utf8')
    await writeFile(join(memories, 'produto', 'preferencia.md'), '# Preferência\nSempre usar o fluxo real.', 'utf8')
    cacheState.memoriesDir = memories
    const { s } = makeSession({ model: 'gpt-5.6-sol' })

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

  it('atualiza uma vez a conversa aberta ao adicionar, alterar ou remover memória', async () => {
    const memories = await mkdtemp(join(tmpdir(), 'agent-session-memory-refresh-'))
    const memoryFile = join(memories, 'MEMORY.md')
    await writeFile(memoryFile, '# Regra\nVersão inicial.', 'utf8')
    cacheState.memoriesDir = memories
    const { s } = makeSession({ model: 'gpt-5.6-sol' })
    await s.start()

    await writeFile(memoryFile, '# Regra\nVersão atualizada e maior.', 'utf8')
    await s.send('depois da alteração')
    const changed = String(pushedMessages(s).at(-1)?.message.content)
    expect(changed).toContain('[PERSISTENT_MEMORY_UPDATE]')
    expect(changed).toContain('Versão atualizada e maior.')
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
    const { s } = makeSession({ model: 'gpt-5.6-sol' })
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
      model: 'gpt-5.6-sol',
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
      model: 'gpt-5.6-sol',
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
      model: 'gpt-5.6-sol',
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
      model: 'gpt-5.6-sol',
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
      model: 'gpt-5.6-sol',
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

  it('skill só do usuário que o SDK não carrega sai do catálogo sem esconder as outras', async () => {
    // Regressão real: `graphify` existia só em ~/.claude/skills (raiz que o CLI
    // via SDK não lê). O tudo-ou-nada antigo anunciava "nenhuma skill" e o
    // modelo parava de chamar caveman/rtk mesmo com o registro nativo cheio.
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
      model: 'gpt-5.6-sol',
      skillRuntime: { appRoot: project, userHome: home }
    })
    await s.start()

    const reloadSkills = vi.fn(async () => ({
      skills: [{ name: 'caveman', description: 'terse', argumentHint: '' }]
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
    expect(first).not.toContain('/graphify')
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
    const { s, emit } = makeSession({ model: 'gpt-5.6-luna' })
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
  it('recalcula e anexa o contexto autoritativo em cada envio', async () => {
    projectOutlineMock
      .mockResolvedValueOnce('[PROJECT_DOCS_CONTEXT]\ndocs/\n  primeiro.md\n[/PROJECT_DOCS_CONTEXT]')
      .mockResolvedValueOnce('[PROJECT_DOCS_CONTEXT]\ndocs/\n  segundo.md\n[/PROJECT_DOCS_CONTEXT]')
    const { s } = makeSession()

    await s.send('primeira')
    await s.send('segunda')

    const messages = pushedMessages(s)
    expect(messages[0].message.content).toContain('primeiro.md')
    expect(messages[1].message.content).toContain('segundo.md')
    expect(projectOutlineMock).toHaveBeenCalledTimes(2)
    expect(projectOutlineMock).toHaveBeenCalledWith('/proj')
  })

  it('falha do contexto não bloqueia nem perde a mensagem', async () => {
    projectOutlineMock.mockRejectedValueOnce(new Error('sem acesso'))
    const { s } = makeSession()

    await s.send('continue mesmo assim')

    const content = pushedMessages(s).at(-1)!.message.content as string
    expect(content).toContain('context unavailable for this dispatch')
    expect(content.endsWith('\n\ncontinue mesmo assim')).toBe(true)
  })

  it('não envia a documentação como pista para o relay de visão', async () => {
    describeImagesMock.mockResolvedValueOnce('descrição')
    projectOutlineMock.mockResolvedValueOnce('[PROJECT_DOCS_CONTEXT]\ndocs/\n  arquitetura.md\n[/PROJECT_DOCS_CONTEXT]')
    const { s } = makeSession({ model: 'glm-5.3:cloud' })

    await s.send('analise a tela', [{ mediaType: 'image/png', data: 'AAA' }])

    expect(describeImagesMock).toHaveBeenCalledWith(expect.any(Array), 'analise a tela')
    expect(pushedMessages(s).at(-1)!.message.content as string).toContain('arquitetura.md')
  })

  it('docs inalterada não reenvia o bloco inteiro — só a nota de uma linha', async () => {
    const outline = '[PROJECT_DOCS_CONTEXT]\ndocs/\n  arquitetura.md\n[/PROJECT_DOCS_CONTEXT]'
    projectOutlineMock.mockResolvedValue(outline)
    const { s } = makeSession()

    await s.send('primeira')
    await s.send('segunda')
    await s.send('terceira')

    const contents = pushedMessages(s).map((m) => m.message.content as string)
    // A 1ª leva o bloco de verdade; as demais só a nota (o modelo já tem o bloco).
    expect(contents[0]).toContain('arquitetura.md')
    expect(contents[1]).not.toContain('arquitetura.md')
    expect(contents[2]).not.toContain('arquitetura.md')
    expect(contents[1]).toContain('Unchanged since the project documentation block')
    // O índice continua sendo relido a cada envio — o que muda é só o que é enviado.
    expect(projectOutlineMock).toHaveBeenCalledTimes(3)
  })

  it('docs mudou no meio da conversa: o bloco completo volta', async () => {
    projectOutlineMock
      .mockResolvedValueOnce('[PROJECT_DOCS_CONTEXT]\ndocs/\n  antigo.md\n[/PROJECT_DOCS_CONTEXT]')
      .mockResolvedValueOnce('[PROJECT_DOCS_CONTEXT]\ndocs/\n  antigo.md\n[/PROJECT_DOCS_CONTEXT]')
      .mockResolvedValueOnce('[PROJECT_DOCS_CONTEXT]\ndocs/\n  novo.md\n[/PROJECT_DOCS_CONTEXT]')
    const { s } = makeSession()

    await s.send('a')
    await s.send('b')
    await s.send('c')

    const contents = pushedMessages(s).map((m) => m.message.content as string)
    expect(contents[0]).toContain('antigo.md')
    expect(contents[1]).not.toContain('antigo.md')
    expect(contents[2]).toContain('novo.md')
  })

  it('sessão nova recebe o bloco completo de novo (o contexto dela está vazio)', async () => {
    const outline = '[PROJECT_DOCS_CONTEXT]\ndocs/\n  arquitetura.md\n[/PROJECT_DOCS_CONTEXT]'
    projectOutlineMock.mockResolvedValue(outline)
    const primeira = makeSession()
    await primeira.s.send('a')
    await primeira.s.send('b')

    const segunda = makeSession()
    await segunda.s.send('c')

    expect(pushedMessages(segunda.s).at(-1)!.message.content as string).toContain('arquitetura.md')
  })

  it('falha do outline não marca como entregue: o envio seguinte leva o bloco completo', async () => {
    const outline = '[PROJECT_DOCS_CONTEXT]\ndocs/\n  arquitetura.md\n[/PROJECT_DOCS_CONTEXT]'
    projectOutlineMock.mockRejectedValueOnce(new Error('sem acesso')).mockResolvedValue(outline)
    const { s } = makeSession()

    await s.send('falhou')
    await s.send('agora vai')

    const contents = pushedMessages(s).map((m) => m.message.content as string)
    expect(contents[0]).toContain('context unavailable for this dispatch')
    expect(contents[1]).toContain('arquitetura.md')
  })
})
