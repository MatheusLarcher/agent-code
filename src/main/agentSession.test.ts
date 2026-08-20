// @vitest-environment node
// Main-process code: pulls in node builtins (via config → store → node:sqlite),
// so it must run in the node env, not the default jsdom (which can't externalize
// the newer node:sqlite builtin and tries to bundle it).
import { describe, it, expect, vi, beforeEach } from 'vitest'
const configState = vi.hoisted(() => ({ windowsControlEnabled: false as unknown }))
const codexState = vi.hoisted(() => ({ connected: true }))
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
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: ensureCodexProxyMock }))
const projectOutlineMock = vi.hoisted(() => vi.fn(async () => '[PROJECT_DOCS_OUTLINE]\ndocs/\n[/PROJECT_DOCS_OUTLINE]'))
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
import { AgentSession, OPENAI_MAX_TURNS, buildContextStamp } from './agentSession'
import type { BrowserController } from './browserController'
import type { UiMockupArtifact, UiMockupSeed } from '../shared/ipc'
import { UI_MOCKUP_CSP } from '../shared/uiMockup'
import { FINAL_ERROR } from './wiremdTools'

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
function makeSession(
  opts: {
    skipPermissions?: boolean
    model?: string
    fastMode?: boolean
    effort?: string
    uiMockups?: UiMockupSeed[]
  } = {}
): {
  s: AgentSession
  emit: ReturnType<typeof vi.fn>
  ask: ReturnType<typeof vi.fn>
  expire: ReturnType<typeof vi.fn>
} {
  const emit = vi.fn()
  const ask = vi.fn()
  const expire = vi.fn()
  const browser = {} as BrowserController
  const s = new AgentSession({ convId: 'c1', cwd: '/proj', ...opts }, browser, emit, ask, expire)
  return { s, emit, ask, expire }
}

// handlePermission is private; reach it directly for the test.
const gate = (s: AgentSession, name: string, input: Record<string, unknown>, agentId?: string): Promise<unknown> =>
  (s as unknown as {
    handlePermission(n: string, i: Record<string, unknown>, a?: string): Promise<unknown>
  }).handlePermission(
    name,
    input,
    agentId
  )

// handleMessage is private; reach it directly to drive a raw SDK message.
const handle = (s: AgentSession, message: unknown): void =>
  (s as unknown as { handleMessage(m: unknown): void }).handleMessage(message)

beforeEach(() => {
  configState.windowsControlEnabled = false
  codexState.connected = true
  queryMock.mockClear()
  ensureCodexProxyMock.mockClear()
  projectOutlineMock.mockReset()
  projectOutlineMock.mockResolvedValue('[PROJECT_DOCS_OUTLINE]\ndocs/\n[/PROJECT_DOCS_OUTLINE]')
})

describe('AgentSession — fluxo de permissão', () => {
  it('auto-aprova ferramenta de leitura e DEVOLVE o input (updatedInput)', async () => {
    const { s, ask } = makeSession()
    const res = await gate(s, 'Read', { file_path: '/a.py' })
    expect(ask).not.toHaveBeenCalled()
    expect(res).toEqual({ behavior: 'allow', updatedInput: { file_path: '/a.py' } })
  })

  it('auto-aprova somente os dois nomes exatos da tool local de mockup', async () => {
    const { s, ask } = makeSession()
    const input = { title: 'Painel', source: '# Painel', viewport: 'desktop' }

    await expect(gate(s, 'render_ui_mockup', input)).resolves.toEqual({ behavior: 'allow', updatedInput: input })
    await expect(gate(s, 'mcp__wiremd__render_ui_mockup', input)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input
    })
    expect(ask).not.toHaveBeenCalled()

    void gate(s, 'mcp__wiremd__future_dangerous_tool', input)
    expect(ask).toHaveBeenCalledTimes(1)
    s.dispose()
  })

  it('nega renderização em subagente antes que ela consuma o estado do mockup principal', async () => {
    const { s, ask } = makeSession()
    const input = { title: 'Painel', source: '# Painel', viewport: 'desktop' }

    await expect(gate(s, 'mcp__wiremd__render_ui_mockup', input, 'agent-child')).resolves.toEqual({
      behavior: 'deny',
      message: 'Only the main agent can render an inline UI mockup.'
    })
    expect(ask).not.toHaveBeenCalled()
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

describe('AgentSession — integração do mockup WireMD', () => {
  const artifact: UiMockupArtifact = {
    type: 'ui_mockup',
    id: 'mockup-1',
    version: 2,
    title: 'Central de atendimento',
    source: '# Central de atendimento\n[Buscar](input)',
    html:
      '<!doctype html><html><head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      `<meta http-equiv="Content-Security-Policy" content="${UI_MOCKUP_CSP}">` +
      '<style>.wmd-root{color:#111}</style></head>' +
      '<body class="wmd-root wmd-clean">preview</body></html>',
    viewport: 'desktop'
  }

  const wiremdUse = (id: string, parent: string | null = null): Record<string, unknown> => ({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      content: [
        {
          type: 'tool_use',
          id,
          name: 'mcp__wiremd__render_ui_mockup',
          input: { title: artifact.title, source: artifact.source, viewport: artifact.viewport }
        }
      ]
    }
  })

  const wiremdResult = (
    id: string,
    parent: string | null = null,
    toolUseResult: unknown = { structuredContent: artifact }
  ): Record<string, unknown> => ({
    type: 'user',
    parent_tool_use_id: parent,
    tool_use_result: toolUseResult,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: JSON.stringify({ ok: true, type: 'ui_mockup', id: artifact.id, version: artifact.version })
        }
      ]
    }
  })

  it('registra o MCP, ensina a sintaxe real/retry e inclui sementes sem HTML no prompt', async () => {
    const seed: UiMockupSeed = {
      id: 'saved-1',
      version: 4,
      title: 'Painel salvo',
      source: '# Painel salvo\n((92%)){success}',
      viewport: 'desktop'
    }
    const { s } = makeSession({ uiMockups: [seed] })
    await s.start()

    const options = (queryMock.mock.calls.at(-1)?.[0] as { options: Record<string, unknown> }).options
    const mcpServers = options.mcpServers as Record<string, unknown>
    const prompt = (options.systemPrompt as { append: string }).append
    expect(mcpServers.wiremd).toBeDefined()
    expect(prompt).toContain('::: columns-3')
    expect(prompt).toContain('::: column')
    expect(prompt).toContain('<row>')
    expect(prompt).toContain('retryAllowed:true')
    expect(prompt).toContain('Não consegui renderizar este mockup.')
    expect(prompt).toContain('Me mostra como ficaria o dashboard')
    expect(prompt).toContain('Quais métricas esse dashboard deveria ter?')
    expect(prompt).toContain('Implemente essa tela em React')
    expect(prompt).toContain('initial or most relevant screen')
    expect(prompt).toContain('rendered preview is the main response')
    expect(prompt).toContain('at most one short sentence before the call')
    expect(prompt).toContain('ASCII wireframe')
    expect(prompt).toContain(seed.title)
    expect(prompt).toContain(JSON.stringify(seed.source))
    expect(prompt).not.toContain('<!doctype html>')
  })

  it('não reseta o retry cedo quando outro turno é enfileirado', async () => {
    const { s } = makeSession()
    const controller = (s as unknown as { wiremdController: { beginTurn(): void } }).wiremdController
    const beginTurn = vi.spyOn(controller, 'beginTurn')

    await s.send('primeiro turno')
    await s.send('segundo turno')
    expect(beginTurn).toHaveBeenCalledTimes(1)

    // Só a conclusão do turno principal transfere o orçamento para o próximo.
    handle(s, { type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1 })
    expect(beginTurn).toHaveBeenCalledTimes(2)

    // Resultado de subagente não é uma fronteira de turno do usuário.
    handle(s, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'peer',
      duration_ms: 1,
      origin: { kind: 'peer' }
    })
    expect(beginTurn).toHaveBeenCalledTimes(2)

    handle(s, { type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 1 })
    expect(beginTurn).toHaveBeenCalledTimes(2)
  })

  it('valida e deduplica sementes recebidas no boundary da sessão', () => {
    const unsafe = { id: '', version: 0, title: 'Inválido', source: '', viewport: 'desktop' }
    const seeds = [
      unsafe,
      { id: 'old', version: 1, title: ' Painel ', source: '# antigo', viewport: 'desktop' },
      { id: 'new', version: 3, title: 'painel', source: '# novo', viewport: 'mobile' },
      { id: 'other', version: 2, title: 'Outro', source: '# outro', viewport: 'desktop' }
    ] as UiMockupSeed[]
    const { s } = makeSession({ uiMockups: seeds })
    const controller = (s as unknown as {
      wiremdController: { seeds(): UiMockupSeed[] }
    }).wiremdController

    expect(controller.seeds()).toEqual([
      { id: 'other', version: 2, title: 'Outro', source: '# outro', viewport: 'desktop' },
      { id: 'new', version: 3, title: 'painel', source: '# novo', viewport: 'mobile' }
    ])
  })

  it('ignora um payload uiMockups malformado no boundary IPC', () => {
    const { s } = makeSession({ uiMockups: {} as unknown as UiMockupSeed[] })
    const controller = (s as unknown as {
      wiremdController: { seeds(): UiMockupSeed[] }
    }).wiremdController

    expect(controller.seeds()).toEqual([])
  })

  it('limita o estado WireMD reinjetado no system prompt às 12 revisões mais recentes', async () => {
    const seeds = Array.from({ length: 13 }, (_, index): UiMockupSeed => ({
      id: `saved-${index}`,
      version: 1,
      title: `Tela ${index}`,
      source: `# Fonte exclusiva ${index}`,
      viewport: 'desktop'
    }))
    const { s } = makeSession({ uiMockups: seeds })
    await s.start()

    const options = (queryMock.mock.calls.at(-1)?.[0] as { options: Record<string, unknown> }).options
    const prompt = (options.systemPrompt as { append: string }).append
    expect(prompt).toContain('# Fonte exclusiva 12')
    expect(prompt).toContain('# Fonte exclusiva 1')
    expect(prompt).not.toContain(JSON.stringify('# Fonte exclusiva 0'))
    expect(prompt).toContain('1 older mockup(s) remain in history')
  })

  it('troca tool-use/result genéricos por um único artifact no track principal', () => {
    const { s, emit } = makeSession()
    handle(s, wiremdUse('wm-main'))
    expect(emit).not.toHaveBeenCalled()

    handle(s, wiremdResult('wm-main'))

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({ kind: 'ui-mockup', artifact, parentToolUseId: null })
    expect(emit.mock.calls.flat().some((event) => event?.kind === 'tool-use' || event?.kind === 'tool-result')).toBe(false)
  })

  it('trata o preview como resposta final e suprime texto posterior no mesmo turno', async () => {
    const { s, emit } = makeSession()
    handle(s, wiremdUse('wm-final'))
    handle(s, wiremdResult('wm-final'))
    emit.mockClear()

    handle(s, {
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'after-preview' } }
    })
    handle(s, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Resumo indevido' } }
    })
    handle(s, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Resumo indevido' }] }
    })
    expect(emit).not.toHaveBeenCalled()

    handle(s, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Não consegui renderizar este mockup.' }] }
    })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'assistant-text', text: 'Não consegui renderizar este mockup.', final: true
    }))
    emit.mockClear()

    await s.send('novo turno')
    handle(s, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Texto permitido' }] }
    })
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'assistant-text', text: 'Texto permitido', final: true
    }))
  })

  it('preserva parentToolUseId no artifact de subagente sem emitir cards genéricos', () => {
    const { s, emit } = makeSession()
    handle(s, wiremdUse('wm-child', 'task-parent'))
    handle(s, wiremdResult('wm-child', 'task-parent'))

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({ kind: 'ui-mockup', artifact, parentToolUseId: 'task-parent' })
  })

  it('recupera o artifact pendente por id e versão quando o bridge omite structuredContent', () => {
    const { s, emit } = makeSession()
    const controller = (s as unknown as {
      wiremdController: { pendingArtifacts: Map<string, UiMockupArtifact> }
    }).wiremdController
    controller.pendingArtifacts.set(`${artifact.id}:${artifact.version}`, artifact)

    handle(s, wiremdUse('wm-fallback'))
    handle(s, wiremdResult('wm-fallback', null, null))

    expect(emit).toHaveBeenCalledWith({ kind: 'ui-mockup', artifact, parentToolUseId: null })
    expect(controller.pendingArtifacts.has(`${artifact.id}:${artifact.version}`)).toBe(false)
  })

  it('não envia structuredContent inseguro ao renderer', () => {
    const { s, emit } = makeSession()
    handle(s, wiremdUse('wm-unsafe'))
    handle(s, wiremdResult('wm-unsafe', null, {
      structuredContent: { ...artifact, html: '<!doctype html><script>alert(1)</script>' }
    }))

    expect(emit).not.toHaveBeenCalled()
  })

  it('suprime também o tool-result de erro do WireMD', () => {
    const { s, emit } = makeSession()
    handle(s, wiremdUse('wm-error'))
    handle(s, {
      type: 'user',
      parent_tool_use_id: null,
      tool_use_result: 'Error: inválido',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'wm-error', is_error: true, content: '{"retryAllowed":true}' }
        ]
      }
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('normaliza a segunda falha no host e suprime qualquer texto posterior do modelo', () => {
    const { s, emit } = makeSession()
    handle(s, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Vou montar a prévia.' }] }
    })
    const leadId = (emit.mock.calls.at(-1)?.[0] as { id: string }).id
    emit.mockClear()

    handle(s, wiremdUse('wm-terminal'))
    handle(s, {
      type: 'user',
      parent_tool_use_id: null,
      tool_use_result: `Error: ${FINAL_ERROR}`,
      message: {
        content: [
          {
            type: 'tool_result', tool_use_id: 'wm-terminal', is_error: true,
            content: JSON.stringify({ ok: false, retryAllowed: false, message: FINAL_ERROR })
          }
        ]
      }
    })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith({
      kind: 'assistant-text', id: leadId, text: FINAL_ERROR, final: true
    })
    emit.mockClear()

    handle(s, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Texto indevido' } }
    })
    handle(s, {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Outra explicação indevida.' }] }
    })
    expect(emit).not.toHaveBeenCalled()
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
    const { s } = makeSession({ model: 'glm-5.2:cloud' })

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
    const { s } = makeSession({ model: 'deepseek-v4-pro:cloud' })

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
    const { s } = makeSession({ model: 'glm-5.2:cloud' })

    await s.send('só texto, sem imagem')

    expect(describeImagesMock).not.toHaveBeenCalled()
    const [msg] = pushedMessages(s)
    // O texto recebe o carimbo e o índice fresco de documentação do projeto.
    expect(msg.message.content).toBe(
      `${buildContextStamp('pc')}\n\n[PROJECT_DOCS_OUTLINE]\ndocs/\n[/PROJECT_DOCS_OUTLINE]\n\nsó texto, sem imagem`
    )
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

describe('AgentSession — índice de docs por mensagem', () => {
  it('recalcula e anexa o índice em cada envio', async () => {
    projectOutlineMock
      .mockResolvedValueOnce('[PROJECT_DOCS_OUTLINE]\ndocs/\n  primeiro.md\n[/PROJECT_DOCS_OUTLINE]')
      .mockResolvedValueOnce('[PROJECT_DOCS_OUTLINE]\ndocs/\n  segundo.md\n[/PROJECT_DOCS_OUTLINE]')
    const { s } = makeSession()

    await s.send('primeira')
    await s.send('segunda')

    const messages = pushedMessages(s)
    expect(messages[0].message.content).toContain('primeiro.md')
    expect(messages[1].message.content).toContain('segundo.md')
    expect(projectOutlineMock).toHaveBeenCalledTimes(2)
    expect(projectOutlineMock).toHaveBeenCalledWith('/proj')
  })

  it('falha do índice não bloqueia nem perde a mensagem', async () => {
    projectOutlineMock.mockRejectedValueOnce(new Error('sem acesso'))
    const { s } = makeSession()

    await s.send('continue mesmo assim')

    const content = pushedMessages(s).at(-1)!.message.content as string
    expect(content).toContain('outline unavailable for this dispatch')
    expect(content.endsWith('\n\ncontinue mesmo assim')).toBe(true)
  })

  it('não envia o índice como pista para o relay de visão', async () => {
    describeImagesMock.mockResolvedValueOnce('descrição')
    projectOutlineMock.mockResolvedValueOnce('[PROJECT_DOCS_OUTLINE]\ndocs/\n  arquitetura.md\n[/PROJECT_DOCS_OUTLINE]')
    const { s } = makeSession({ model: 'glm-5.2:cloud' })

    await s.send('analise a tela', [{ mediaType: 'image/png', data: 'AAA' }])

    expect(describeImagesMock).toHaveBeenCalledWith(expect.any(Array), 'analise a tela')
    expect(pushedMessages(s).at(-1)!.message.content as string).toContain('arquitetura.md')
  })
})
