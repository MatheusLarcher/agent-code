import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// Mocks do Electron e das dependências do index.ts (antes do import('./index')).
import { callIpc as call, sessionsOf, spy } from './testing/electronMocks'

vi.mock('./sessionLog', () => ({ initSessionLog: vi.fn(), logSession: vi.fn() }))

const { AUTO_MODEL, Channels } = await import('../shared/ipc')
const { registerIpc, mcpInbound } = await import('./index')
const { RemoteServer } = await import('./remote/remoteServer')
const { resolveAutoStart } = await import('./typesafe')
const { ProviderFailoverSession } = await import('./providerFailover')
const { logSession } = await import('./sessionLog')

// "Viva, salvo as conversas marcadas como mortas" (o mock compartilhado diz sempre viva).
const deadConvs = new Set<string>()
;(ProviderFailoverSession.prototype as unknown as { isAlive(): boolean }).isAlive = function (this: { opts: { convId: string } }) {
  return !deadConvs.has(this.opts.convId)
}

// Decisão do Automático (typesafe mockado): `reuse` = "o par repetiu".
const decide = (model: string, effort: string, reuse: boolean) =>
  ({ execution: { model, effort }, reuse, note: null, live: { model, effort, decided: { model: true, effort: true } } }) as never

describe('agent:start — sessão com trabalho em background não é trocada', () => {
  const cwd = tmpdir()
  const autoStart = (convId: string, message: string) =>
    call(Channels.agentStart, { convId, cwd, model: AUTO_MODEL, effort: 'high', autoPrompt: { message } })

  beforeAll(() => registerIpc())
  beforeEach(() => {
    vi.mocked(logSession).mockClear()
    vi.mocked(resolveAutoStart).mockReset()
  })

  it('Automático escolhe outro par com background ativo: a viva fica (sem dispose, sem sessão nova, sem consultar o TypeSafe)', async () => {
    const conv = 'bg-auto'
    vi.mocked(resolveAutoStart).mockResolvedValue(decide('claude-opus-5-5', 'high', false))
    await autoStart(conv, 'primeira')
    const [a] = sessionsOf(conv)
    spy.background.add(conv)
    vi.mocked(resolveAutoStart).mockClear().mockResolvedValue(decide('claude-sonnet-5-5', 'low', false))
    await expect(autoStart(conv, 'segunda')).resolves.toEqual({ ok: true, claudeAccountId: 'default' })
    expect(sessionsOf(conv)).toHaveLength(1)
    expect(a.dispose).not.toHaveBeenCalled()
    expect(resolveAutoStart).not.toHaveBeenCalled()
    expect(logSession).toHaveBeenCalledWith('session-kept', expect.objectContaining({ convId: conv, reason: 'background', background: true }))
    // A mensagem sai na sessão de sempre.
    await call(Channels.agentSend, conv, 'segunda')
    expect(a.send).toHaveBeenCalled()
    // O background acabou: o par diferente volta a trocar a sessão (com o motivo no log).
    spy.background.delete(conv)
    await autoStart(conv, 'terceira')
    expect(sessionsOf(conv)).toHaveLength(2)
    expect(a.dispose).toHaveBeenCalled()
    expect(logSession).toHaveBeenCalledWith('session-replaced', expect.objectContaining({ convId: conv, reason: 'auto-pair', background: false }))
    expect(logSession).toHaveBeenCalledWith('session-start', expect.objectContaining({ convId: conv, model: 'claude-sonnet-5-5', effort: 'low' }))
  })

  it('reinício por configuração (modelo fixo trocado) com background ativo: a viva fica', async () => {
    const conv = 'bg-config'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5', effort: 'high' })
    const [a] = sessionsOf(conv)
    spy.background.add(conv)
    await expect(call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', effort: 'high' })).resolves.toEqual({
      ok: true,
      claudeAccountId: 'default'
    })
    expect(sessionsOf(conv)).toHaveLength(1)
    expect(a.dispose).not.toHaveBeenCalled()
    spy.background.delete(conv)
  })

  it('sem background: a troca de sempre (config) continua', async () => {
    const conv = 'bg-none'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5', effort: 'high' })
    const [a] = sessionsOf(conv)
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', effort: 'high' })
    expect(sessionsOf(conv)).toHaveLength(2)
    expect(a.dispose).toHaveBeenCalled()
    expect(logSession).toHaveBeenCalledWith('session-replaced', expect.objectContaining({ convId: conv, reason: 'config' }))
  })

  it('sessão morta não segura nada, mesmo marcada com background: sobe outra', async () => {
    const conv = 'bg-dead'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5', effort: 'high' })
    const [a] = sessionsOf(conv)
    spy.background.add(conv)
    deadConvs.add(conv)
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5', effort: 'high' })
    expect(sessionsOf(conv)).toHaveLength(2)
    expect(a.dispose).toHaveBeenCalled()
    expect(logSession).toHaveBeenCalledWith('session-replaced', expect.objectContaining({ convId: conv, reason: 'dead', background: true }))
    spy.background.delete(conv)
    deadConvs.delete(conv)
  })

  it('descarte explícito (agent:dispose) com background ativo continua descartando — e registra', async () => {
    const conv = 'bg-dispose'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5', effort: 'high' })
    const [a] = sessionsOf(conv)
    spy.background.add(conv)
    await call(Channels.agentDispose, conv)
    expect(a.dispose).toHaveBeenCalled()
    expect(logSession).toHaveBeenCalledWith('session-disposed', expect.objectContaining({ convId: conv, reason: 'dispose', background: true }))
    // Depois do descarte, o agent:start sobe uma sessão nova normalmente.
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', effort: 'high' })
    expect(sessionsOf(conv)).toHaveLength(2)
    spy.background.delete(conv)
  })

  it('troca de pasta ou de config MCP com background: mantida, mas registrada e avisada no chat', async () => {
    const broadcast = vi.spyOn(RemoteServer.prototype as unknown as { broadcast(c: string, e: unknown): void }, 'broadcast')
    const conv = 'bg-cwd'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5', effort: 'high' })
    const [a] = sessionsOf(conv)
    spy.background.add(conv)
    const other = join(cwd, '..')
    await call(Channels.agentStart, { convId: conv, cwd: other, model: 'claude-opus-5-5', effort: 'high' })
    expect(sessionsOf(conv)).toHaveLength(1)
    expect(a.dispose).not.toHaveBeenCalled()
    expect(logSession).toHaveBeenCalledWith('session-kept', expect.objectContaining({ convId: conv, cwdChanged: true, mcpChanged: false }))
    expect(broadcast).toHaveBeenLastCalledWith(conv, expect.objectContaining({ kind: 'status', text: expect.stringMatching(/troca de pasta fica para quando o background terminar/) }))
    // Config MCP aparecendo para a conversa (registro do main) com background ativo.
    mcpInbound.registry.setConfig(conv, { cliente: 'Forgia', mcpServers: {} })
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5', effort: 'high' })
    expect(sessionsOf(conv)).toHaveLength(1)
    expect(logSession).toHaveBeenLastCalledWith('session-kept', expect.objectContaining({ mcpChanged: true, cwdChanged: false }))
    expect(broadcast).toHaveBeenLastCalledWith(conv, expect.objectContaining({ text: expect.stringMatching(/troca da configuração MCP fica/) }))
    spy.background.delete(conv)
  })

  it('todo error terminal da conversa vai para o log (sem o texto)', async () => {
    const conv = 'bg-erro'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5', effort: 'high' })
    const [a] = sessionsOf(conv)
    a.emit({ kind: 'error', id: 'e1', text: 'segredo do usuário', incomplete: true, retryable: true, turnIds: ['t1'] })
    expect(logSession).toHaveBeenCalledWith('turn-error', expect.objectContaining({ convId: conv, incomplete: true, retryable: true, turnIds: ['t1'] }))
    const fields = vi.mocked(logSession).mock.calls.find(([event]) => event === 'turn-error')?.[1]
    expect(JSON.stringify(fields)).not.toContain('segredo')
  })
})
