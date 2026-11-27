import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it, vi } from 'vitest'
// Mocks do Electron e das dependências do index.ts, compartilhados com index.test.ts.
import { callIpc as call, keepers, sessionsOf } from './testing/electronMocks'

// O preparo real (SDK + Postgres) é coberto em sessionResume.test.ts; aqui só o
// que o agent:start faz com cada resposta dele.
const prepare = vi.hoisted(() => vi.fn(async (): Promise<'ready' | 'missing'> => 'ready'))
vi.mock('./sessionResume', () => ({ prepareSessionResume: prepare }))

const { Channels } = await import('../shared/ipc')
const { RemoteServer } = await import('./remote/remoteServer')
const { registerIpc } = await import('./index')

const broadcast = vi.spyOn(RemoteServer.prototype, 'broadcast')
const notices = (conv: string): string[] =>
  broadcast.mock.calls
    .filter(([c, e]) => c === conv && (e as { kind?: string }).kind === 'status')
    .map(([, e]) => (e as { text: string }).text)

describe('agent:start — conversa cujo transcript sumiu', () => {
  const cwd = tmpdir()
  beforeAll(() => registerIpc())

  // Antes: SESSION_HANDOFF_INCOMPLETE a cada subida (o renderer reenvia o mesmo
  // sdkSessionId) e a conversa nunca mais aceitava mensagem.
  it('sem transcript para retomar: sobe sessão NOVA (sem resume), avisa uma vez e a conversa aceita envio', async () => {
    const conv = 'retomada-sem-transcript'
    prepare.mockResolvedValueOnce('missing')
    const before = keepers.length
    const result = await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', resume: 'sdk-perdida' })
    expect(result).toMatchObject({ ok: true })
    expect(prepare).toHaveBeenLastCalledWith(expect.anything(), conv, cwd, 'sdk-perdida')
    const [s] = sessionsOf(conv)
    expect(s).toBeDefined()
    expect((s.opts as { resume?: string }).resume).toBeUndefined()
    // O lease ficou com a sessão nova (não foi solto como numa falha).
    const mine = keepers.slice(before)
    expect(mine).toHaveLength(1)
    expect(mine[0].release).not.toHaveBeenCalled()
    expect(notices(conv)).toEqual([expect.stringContaining('começou do zero')])
    expect(notices(conv)[0]).toContain('As mensagens continuam aqui')
    // A conversa não está travada: o envio chega à sessão nova.
    await call(Channels.agentSend, conv, 'oi', [], [], [], undefined, undefined, undefined)
    expect(s.send).toHaveBeenCalledTimes(1)
  })

  it('transcript presente: retoma a MESMA sessão, sem aviso', async () => {
    const conv = 'retomada-com-transcript'
    prepare.mockResolvedValueOnce('ready')
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', resume: 'sdk-ok' })
    expect((sessionsOf(conv)[0].opts as { resume?: string }).resume).toBe('sdk-ok')
    expect(notices(conv)).toEqual([])
  })

  it('outras falhas do preparo (banco, verificação) continuam barrando a subida e soltam o lease', async () => {
    const conv = 'retomada-falha-banco'
    prepare.mockRejectedValueOnce(new Error('Persistência autoritativa offline.'))
    const before = keepers.length
    await expect(
      call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', resume: 'sdk-x' })
    ).rejects.toThrow('Persistência autoritativa offline.')
    expect(sessionsOf(conv)).toEqual([])
    expect(keepers.slice(before)[0]?.release).toHaveBeenCalledTimes(1)
    expect(notices(conv)).toEqual([])
  })
})
