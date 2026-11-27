// @vitest-environment node
// Pedido de permissão de um subagente (agente do time em segundo plano): passa
// pelo mesmo canUseTool -> handlePermission com o agentID do SDK, vai à tela pelo
// askPermission e continua de pé depois do `result` do turno principal — o
// subagente segue rodando. Antes, a tela apagava a fila no `result` e o pedido
// expirava sem o usuário ver; por isso o main avisa o renderer sempre que tira um
// pedido (aqui: "Permitir tudo" e fim da sessão).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserController } from './browserController'

vi.mock('./sessionLog', () => ({ logSession: vi.fn() }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ dir: '', memoriesDir: '', skillsDir: '' }) }))
vi.mock('./config', () => ({
  loadConfig: () => ({ windowsControlEnabled: false, chromeControlEnabled: false, ollama: { enabled: false, apiKey: '' }, board: {} })
}))

import { AgentSession } from './agentSession'

type Result = { behavior: string; updatedInput?: unknown; message?: string }
type Internals = {
  handlePermission(name: string, input: Record<string, unknown>, agentId?: string): Promise<Result>
  handleMessage(m: unknown): void
  pendingPermissions: Map<string, unknown>
}

const okResult = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'lancei os executores em segundo plano',
  duration_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  session_id: 's',
  uuid: 'r'
}

function setup() {
  const ask = vi.fn()
  const closed = vi.fn()
  const s = new AgentSession({ convId: 'c-sub', cwd: '/p' }, {} as BrowserController, vi.fn(), ask, closed)
  return { s, ask, closed, internals: s as unknown as Internals }
}

afterEach(() => vi.clearAllMocks())

describe('AgentSession — permissão pedida por subagente', () => {
  it('vai à tela, sobrevive ao `result` do turno principal e a resposta volta ao subagente', async () => {
    const { s, ask, closed, internals } = setup()
    const input = { command: 'Get-Date' }
    const answer = internals.handlePermission('PowerShell', input, 'agent-executor-1')
    expect(ask).toHaveBeenCalledTimes(1)
    const req = ask.mock.calls[0][0] as { id: string; toolName: string }
    expect(req.toolName).toBe('PowerShell')

    internals.handleMessage(okResult)
    expect(internals.pendingPermissions.has(req.id)).toBe(true)
    expect(closed).not.toHaveBeenCalled()

    s.resolvePermission({ id: req.id, behavior: 'allow' })
    await expect(answer).resolves.toEqual({ behavior: 'allow', updatedInput: input })
    s.dispose()
  })

  it('pedido do agente principal segue igual (mesma tela, mesma resposta)', async () => {
    const { s, ask, internals } = setup()
    const answer = internals.handlePermission('PowerShell', { command: 'ls' })
    const req = ask.mock.calls[0][0] as { id: string }
    s.resolvePermission({ id: req.id, behavior: 'deny', message: 'não' })
    await expect(answer).resolves.toEqual({ behavior: 'deny', message: 'não' })
    s.dispose()
  })

  it('"Permitir tudo" aprova o pendente e fecha a janela dele', async () => {
    const { s, ask, closed, internals } = setup()
    const answer = internals.handlePermission('PowerShell', { command: 'ls' }, 'agent-executor-1')
    const req = ask.mock.calls[0][0] as { id: string }
    s.setBypass(true)
    await expect(answer).resolves.toMatchObject({ behavior: 'allow' })
    expect(closed).toHaveBeenCalledWith(req.id)
    s.dispose()
  })

  it('fim da sessão nega o pendente e fecha a janela dele', async () => {
    const { s, ask, closed, internals } = setup()
    const answer = internals.handlePermission('PowerShell', { command: 'ls' }, 'agent-executor-1')
    const req = ask.mock.calls[0][0] as { id: string }
    s.dispose()
    await expect(answer).resolves.toMatchObject({ behavior: 'deny' })
    expect(closed).toHaveBeenCalledWith(req.id)
  })
})
