import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it, vi } from 'vitest'
// Mocks do Electron e das dependências do index.ts, compartilhados com index.test.ts.
import { callIpc as call, keepers, leaseGate, leaseReleases, leasesAcquired, resumeGate, sessionsOf, spy } from './testing/electronMocks'

// Prazos curtos só aqui: os valores reais e a conta deles estão em sessionSteps.test.ts.
vi.mock('./sessionSteps', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sessionSteps')>()
  return { ...real, LEASE_ACQUIRE_DEADLINE_MS: 60, RESUME_PREPARE_DEADLINE_MS: 60 }
})

const { Channels } = await import('../shared/ipc')
const { NO_LIVE_SESSION_MARK } = await import('../shared/mcpInbound')
const { registerIpc, mcpInbound } = await import('./index')

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))
const gate = (): { p: Promise<void>; open: () => void } => {
  let open!: () => void
  const p = new Promise<void>((r) => (open = r))
  return { p, open }
}
const send = (conv: string, text: string, taskId?: string): Promise<unknown> =>
  call(Channels.agentSend, conv, text, [], [], [], undefined, undefined, taskId)

describe('registerIpc — lock sem prazo, prazos por passo, sessão descartada fora do mapa', () => {
  const cwd = tmpdir()
  const config = (conv: string): void => mcpInbound.registry.setConfig(conv, { cliente: 'Forgia', mcpServers: {} })

  beforeAll(() => registerIpc())

  // Sonda do crítico (critico-cb75) convertida: antes, com o lock abandonando a
  // operação, o agent:send seguinte enviava para a sessão já descartada, "dava
  // certo" e a tarefa ficava `rodando` para sempre.
  it('agent:start preso no lease: a antiga sai do mapa na hora; a subida falha no prazo do lease; o envio seguinte dá erro claro e a tarefa vira erro; o lease atrasado é solto', async () => {
    const conv = 'passos-lease-preso'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    config(conv)
    const [a] = sessionsOf(conv)
    const lease = gate()
    leaseGate.p = lease.p
    const stuck = call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' }).catch((e: unknown) => e)
    await tick()
    leaseGate.p = null
    // Descartada e fora do mapa ANTES do lease: o "agora" não entra nela.
    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(await call(Channels.agentInjectNow, conv, 'ajuste', [], [], [], undefined)).toEqual({ ok: false })
    expect(a.injectNow).not.toHaveBeenCalled()
    const t = mcpInbound.registry.create(conv, 'T', 'claude-sonnet-5-5')
    const sending = send(conv, 'T', t.id).catch((e: unknown) => e)
    // A subida falha pelo prazo do lease (o lock não abandona nada: ela mesma falha).
    expect(String(await stuck)).toMatch(/aquisição do lease da conversa não terminou/)
    const before = leasesAcquired.length
    lease.open()
    // O envio esperou a subida terminar de verdade e não achou sessão viva.
    expect(String(await sending)).toContain(NO_LIVE_SESSION_MARK)
    expect(a.send).not.toHaveBeenCalled()
    expect(mcpInbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: expect.stringContaining(NO_LIVE_SESSION_MARK) })
    // Nenhuma sessão nova subiu; a única que existiu foi descartada.
    expect(sessionsOf(conv)).toEqual([a])
    // O lease que chegou tarde (o da subida presa) foi solto e nunca instalado.
    await tick()
    const late = leasesAcquired[before]
    expect(late).toBeDefined()
    expect(leaseReleases).toHaveBeenCalledWith(late)
    expect(keepers.some((k) => k.lease === late)).toBe(false)
    // A conversa não ficou presa: uma subida nova funciona.
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    expect(sessionsOf(conv)).toHaveLength(2)
  })

  it('preparo da retomada preso: a subida falha no prazo, solta o lease que pegou e não sobe sessão; a próxima subida segue', async () => {
    const conv = 'passos-retomada-presa'
    const resume = gate()
    resumeGate.p = resume.p
    const before = keepers.length
    const error = await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', resume: 'sdk-1' }).catch((e: unknown) => e)
    resumeGate.p = null
    expect(String(error)).toMatch(/preparação da retomada da conversa não terminou/)
    expect(sessionsOf(conv)).toEqual([])
    const mine = keepers.slice(before)
    expect(mine).toHaveLength(1)
    expect(mine[0].release).toHaveBeenCalledTimes(1)
    resume.open()
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    expect(sessionsOf(conv)).toHaveLength(1)
  })

  it('agent:send numa conversa sem sessão viva: erro claro, sem pegar lease, e a tarefa vira erro (nunca `rodando`)', async () => {
    const conv = 'passos-sem-sessao'
    config(conv)
    const t = mcpInbound.registry.create(conv, 'T', 'claude-sonnet-5-5')
    const leases = leasesAcquired.length
    await expect(send(conv, 'T', t.id)).rejects.toThrow(NO_LIVE_SESSION_MARK)
    expect(mcpInbound.registry.get(t.id)?.status).toBe('erro')
    expect(leasesAcquired.length).toBe(leases)
    await expect(send(conv, 'oi')).rejects.toThrow(NO_LIVE_SESSION_MARK)
  })

  it('conversa descartada durante a troca de modelo (await no lock): nada é fixado nem enviado em sessão nenhuma; a nova morre e a tarefa vira erro', async () => {
    const conv = 'passos-descartada-na-troca'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    config(conv)
    const [a] = sessionsOf(conv)
    const t = mcpInbound.registry.create(conv, 'T', 'gpt-6-sol')
    const up = gate()
    spy.startResults.push(up.p.then(() => true))
    const sending = send(conv, 'T', t.id).catch((e: unknown) => e)
    // Até a sessão nova subir (um prazo fixo falhava com a suíte inteira rodando em paralelo).
    for (let i = 0; i < 400 && sessionsOf(conv).length < 2; i++) await tick()
    const b = sessionsOf(conv).at(-1)!
    expect(b).not.toBe(a)
    await call(Channels.agentDispose, conv)
    up.open()
    expect(String(await sending)).toMatch(/outra sessão assumiu a conversa durante a troca/)
    expect(a.pinModel).not.toHaveBeenCalled()
    expect(b.pinModel).not.toHaveBeenCalled()
    expect(a.send).not.toHaveBeenCalled()
    expect(b.send).not.toHaveBeenCalled()
    expect(b.dispose).toHaveBeenCalled()
    expect(mcpInbound.registry.get(t.id)?.status).toBe('erro')
  })
})
