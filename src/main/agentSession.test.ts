// @vitest-environment node
// Main-process code: pulls in node builtins (via config → store → node:sqlite),
// so it must run in the node env, not the default jsdom (which can't externalize
// the newer node:sqlite builtin and tries to bundle it).
import { describe, it, expect, vi } from 'vitest'
import { AgentSession } from './agentSession'
import type { BrowserController } from './browserController'

// Build a session without starting the SDK query loop — we only exercise the
// permission gate (handlePermission / resolvePermission / setBypass).
function makeSession(opts: { skipPermissions?: boolean } = {}): {
  s: AgentSession
  ask: ReturnType<typeof vi.fn>
  expire: ReturnType<typeof vi.fn>
} {
  const emit = vi.fn()
  const ask = vi.fn()
  const expire = vi.fn()
  const browser = {} as BrowserController
  const s = new AgentSession({ convId: 'c1', cwd: '/proj', ...opts }, browser, emit, ask, expire)
  return { s, ask, expire }
}

// handlePermission is private; reach it directly for the test.
const gate = (s: AgentSession, name: string, input: Record<string, unknown>): Promise<unknown> =>
  (s as unknown as { handlePermission(n: string, i: Record<string, unknown>): Promise<unknown> }).handlePermission(
    name,
    input
  )

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
