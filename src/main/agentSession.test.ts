// @vitest-environment node
// Main-process code: pulls in node builtins (via config → store → node:sqlite),
// so it must run in the node env, not the default jsdom (which can't externalize
// the newer node:sqlite builtin and tries to bundle it).
import { describe, it, expect, vi, beforeEach } from 'vitest'
const configState = vi.hoisted(() => ({ windowsControlEnabled: false as unknown }))
vi.mock('./config', () => ({
  loadConfig: () => ({ windowsControlEnabled: configState.windowsControlEnabled })
}))
import { AgentSession } from './agentSession'
import type { BrowserController } from './browserController'

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
function makeSession(opts: { skipPermissions?: boolean; model?: string } = {}): {
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

  it('Kimi K2.7 Code (Ollama, único com visão real verificada) + imagem: NÃO chama o relay', async () => {
    const { s } = makeSession({ model: 'kimi-k2.7-code:cloud' })

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
    expect(msg.message.content).toBe('só texto, sem imagem')
  })
})
