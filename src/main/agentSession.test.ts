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
} {
  const emit = vi.fn()
  const ask = vi.fn()
  const browser = {} as BrowserController
  const s = new AgentSession({ convId: 'c1', cwd: '/proj', ...opts }, browser, emit, ask)
  return { s, ask }
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
