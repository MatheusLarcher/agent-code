import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it, vi } from 'vitest'
// Mocks do Electron e das dependências do index.ts, compartilhados com index.test.ts.
import { callIpc as call, leaseGate, sessionsOf, spy } from './testing/electronMocks'

const { AUTO_EFFORT, AUTO_MODEL, Channels } = await import('../shared/ipc')
const { MCP_TASK_GONE_MARK } = await import('../shared/mcpInbound')
const { MCP_SESSION_REPLACED } = await import('./mcpInbound/mcpConstants')
const { registerIpc, mcpInbound } = await import('./index')
const { saveAttachments } = await import('./attachments')
const { ProviderFailoverSession } = await import('./providerFailover')

// O mock compartilhado (testing/electronMocks.ts) não conhece `isAlive`: aqui ele
// vira "viva, salvo as conversas marcadas como mortas".
const deadConvs = new Set<string>()
;(ProviderFailoverSession.prototype as unknown as { isAlive(): boolean }).isAlive = function (this: { opts: { convId: string } }) {
  return !deadConvs.has(this.opts.convId)
}
const { resolveAutoStart } = await import('./typesafe')

/** agent:send como a tela o faz: o item de tarefa MCP leva o id dela (8º argumento). */
const send = (conv: string, text: string, taskId?: string, files: unknown[] = [], kind?: string): Promise<unknown> =>
  call(Channels.agentSend, conv, text, [], files, [], undefined, kind, taskId)
/** Botão "agora" do item: o id da tarefa MCP dele é o 7º argumento. */
const injectNow = (conv: string, text: string, taskId?: string, files: unknown[] = []): Promise<unknown> =>
  call(Channels.agentInjectNow, conv, text, [], files, [], undefined, taskId)

// Decisão do Automático (typesafe mockado): `reuse` = "o par repetiu".
const decide = (model: string, reuse: boolean, tag = model) =>
  ({ execution: { model, effort: 'high' }, reuse, note: null, live: { tag } }) as never

describe('registerIpc — tarefa MCP com modelo pedido (troca de sessão, "agora", ordem)', () => {
  const cwd = tmpdir()
  const result = { kind: 'result', id: 'r', isError: false, text: 'ok', durationMs: 1 }
  const file = { name: 'a.txt', mimeType: 'text/plain', data: 'eA==' }
  const config = (conv: string): void => mcpInbound.registry.setConfig(conv, { cliente: 'Forgia', mcpServers: {} })

  beforeAll(() => registerIpc())

  it('fluxo: "agora" recusado; troca que falha não grava nada e mantém a antiga; troca que sobe; volta ao modelo da conversa', async () => {
    const conv = 'mcp-fluxo'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    const [a] = sessionsOf(conv)
    expect(a.opts.inboundMcp).toBeUndefined()
    // O Forgia manda conversa_id + modelo para a conversa aberta pelo usuário.
    config(conv)
    const t1 = mcpInbound.registry.create(conv, 'tarefa', 'gpt-6-sol')

    // (1) "agora" com outro modelo: recusado antes de gravar, fica na fila.
    const injected = (await injectNow(conv, 'tarefa', t1.id, [file])) as { ok: boolean; reason?: string }
    expect(injected).toMatchObject({ ok: false, reason: expect.stringContaining('gpt-6-sol') })
    expect(a.injectNow).not.toHaveBeenCalled()
    expect(saveAttachments).not.toHaveBeenCalled()
    expect(mcpInbound.registry.get(t1.id)?.status).toBe('na_fila')

    // (3)+(7) A troca falha: nada gravado nem anunciado, a sessão antiga continua a da conversa.
    for (const fn of Object.values(spy.note)) fn.mockClear()
    spy.startResults.push(false)
    await expect(send(conv, 'tarefa', t1.id, [file])).rejects.toThrow(/trocar o modelo/)
    expect(saveAttachments).not.toHaveBeenCalled()
    for (const fn of Object.values(spy.note)) expect(fn).not.toHaveBeenCalled()
    expect(a.dispose).not.toHaveBeenCalled()
    expect(sessionsOf(conv)[1].dispose).toHaveBeenCalled()
    expect(mcpInbound.registry.get(t1.id)).toMatchObject({ status: 'erro', erro: expect.stringMatching(/trocar o modelo/) })
    await send(conv, 'mensagem comum')
    expect(a.send).toHaveBeenCalledTimes(1)

    // (2) A troca sobe: sessão nova no modelo da tarefa e com a config MCP; só então a antiga sai.
    const t2 = mcpInbound.registry.create(conv, 'tarefa 2', 'gpt-6-sol')
    await send(conv, 'tarefa 2', t2.id)
    const b = sessionsOf(conv).at(-1)!
    expect(b.opts).toMatchObject({ model: 'gpt-6-sol', inboundMcp: { cliente: 'Forgia' } })
    expect(a.dispose).toHaveBeenCalled()
    expect(b.send).toHaveBeenCalled()
    expect(b.pinModel).toHaveBeenLastCalledWith(true)
    expect(mcpInbound.registry.get(t2.id)?.status).toBe('rodando')

    // (1) Mesmo modelo: o "agora" entra no turno como hoje e fixa o modelo.
    const ajuste = mcpInbound.registry.create(conv, 'ajuste', 'gpt-6-sol')
    expect(await injectNow(conv, 'ajuste', ajuste.id)).toEqual({ ok: true })
    expect(b.injectNow).toHaveBeenCalled()
    expect(b.pinModel).toHaveBeenLastCalledWith(true)

    // (6) Fim da tarefa: a mensagem seguinte do usuário volta ao modelo da conversa.
    b.emit(result)
    expect(mcpInbound.registry.get(t2.id)?.status).toBe('concluida')
    await send(conv, 'e agora?')
    const c = sessionsOf(conv).at(-1)!
    expect(c).not.toBe(b)
    expect(c.opts.model).toBe('claude-sonnet-5-5')
    expect(b.dispose).toHaveBeenCalled()
    expect(c.pinModel).toHaveBeenLastCalledWith(false)
    expect(c.send).toHaveBeenCalled()
  })

  it('texto igual ao de tarefas: o "agora" e o envio seguem o ID do item, nunca o texto', async () => {
    const conv = 'mcp-mesmo-texto'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5' })
    config(conv)
    const [a] = sessionsOf(conv)
    // A sessão já sobe com a config (conversa MCP) no modelo da conversa (opus).
    const t1 = mcpInbound.registry.create(conv, 'X', 'claude-opus-5-5')
    const t2 = mcpInbound.registry.create(conv, 'X', 'gpt-6-sol')
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5' })
    const live = sessionsOf(conv).at(-1)!
    expect(a.dispose).toHaveBeenCalled()
    // "agora" na T2 (gpt) com a sessão em opus: recusado pelo modelo DA T2.
    expect(await injectNow(conv, 'X', t2.id)).toMatchObject({ ok: false, reason: expect.stringContaining('gpt-6-sol') })
    // "agora" na T1 (opus): entra, e marca a T1 — não a T2.
    expect(await injectNow(conv, 'X', t1.id)).toEqual({ ok: true })
    expect([mcpInbound.registry.get(t1.id)?.status, mcpInbound.registry.get(t2.id)?.status]).toEqual(['rodando', 'na_fila'])
    live.emit(result)
    // Mensagem do usuário com o mesmo texto (sem id): modelo da conversa, sem pin; a T2 fica na fila.
    const before = spy.sessions.length
    await send(conv, 'X')
    expect(spy.sessions.length).toBe(before)
    expect(live.pinModel).toHaveBeenLastCalledWith(false)
    expect(mcpInbound.registry.get(t2.id)?.status).toBe('na_fila')
  })

  it('esforço Automático: a troca da tarefa nunca cai no reaproveitamento e o TypeSafe vê a mensagem que sai', async () => {
    const conv = 'mcp-auto-esforco'
    vi.mocked(resolveAutoStart).mockReset().mockResolvedValue(decide('claude-opus-5-5', false))
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-opus-5-5', effort: AUTO_EFFORT, autoPrompt: { message: 'velha' } })
    const [a] = sessionsOf(conv)
    // Aberta antes da config MCP; a tarefa pede o MESMO modelo e o par repete (reuse).
    config(conv)
    const t = mcpInbound.registry.create(conv, 'peça')
    vi.mocked(resolveAutoStart).mockResolvedValue(decide('claude-opus-5-5', true))
    await send(conv, 'peça', t.id)
    const b = sessionsOf(conv).at(-1)!
    expect(b).not.toBe(a)
    expect(b.opts).toMatchObject({ model: 'claude-opus-5-5', inboundMcp: { cliente: 'Forgia' } })
    expect(a.dispose).toHaveBeenCalled()
    expect(vi.mocked(resolveAutoStart).mock.calls.at(-1)?.[0]).toMatchObject({ autoPrompt: { message: 'peça' } })
    expect(mcpInbound.registry.get(t.id)?.status).toBe('rodando')
  })

  it('modelo Automático: mensagem do usuário depois da tarefa não reaproveita a sessão no modelo da tarefa', async () => {
    const conv = 'mcp-auto-modelo'
    config(conv)
    const t = mcpInbound.registry.create(conv, 'T', 'gpt-6-sol')
    vi.mocked(resolveAutoStart).mockReset().mockResolvedValue(decide('claude-opus-5-5', false))
    await call(Channels.agentStart, { convId: conv, cwd, model: AUTO_MODEL, effort: 'high', autoPrompt: { message: 'T' } })
    await send(conv, 'T', t.id)
    const tarefa = sessionsOf(conv).at(-1)!
    expect(tarefa.opts.model).toBe('gpt-6-sol')
    tarefa.emit(result)
    // O Automático escolhe opus para a mensagem do usuário e diz "o par repetiu":
    // a viva está no gpt da tarefa, então sobe outra.
    vi.mocked(resolveAutoStart).mockReset().mockResolvedValue(decide('claude-opus-5-5', true))
    await call(Channels.agentStart, { convId: conv, cwd, model: AUTO_MODEL, effort: 'high', autoPrompt: { message: 'oi' } })
    const user = sessionsOf(conv).at(-1)!
    expect(user).not.toBe(tarefa)
    expect(user.opts.model).toBe('claude-opus-5-5')
    // Viva já no modelo decidido e com a mesma config: aí sim reaproveita.
    const before = spy.sessions.length
    await call(Channels.agentStart, { convId: conv, cwd, model: AUTO_MODEL, effort: 'high', autoPrompt: { message: 'e mais' } })
    expect(spy.sessions.length).toBe(before)
  })

  it('Automático: query morta nunca é reaproveitada (sessão nova, antiga descartada); query viva continua reusada', async () => {
    const conv = 'auto-query-morta'
    vi.mocked(resolveAutoStart).mockReset().mockResolvedValue(decide('claude-opus-5-5', false))
    await call(Channels.agentStart, { convId: conv, cwd, model: AUTO_MODEL, effort: 'high', autoPrompt: { message: 'a' } })
    const [a] = sessionsOf(conv)
    vi.mocked(resolveAutoStart).mockReset().mockResolvedValue(decide('claude-opus-5-5', true))
    // Viva: reaproveita.
    await call(Channels.agentStart, { convId: conv, cwd, model: AUTO_MODEL, effort: 'high', autoPrompt: { message: 'b' } })
    expect(sessionsOf(conv)).toHaveLength(1)
    // Morta: o par repetiu, mas a sessão não serve — sobe outra e descarta a antiga.
    deadConvs.add(conv)
    await send(conv, 'c')
    await call(Channels.agentStart, { convId: conv, cwd, model: AUTO_MODEL, effort: 'high', autoPrompt: { message: 'c' } })
    const b = sessionsOf(conv).at(-1)!
    expect(b).not.toBe(a)
    expect(a.dispose).toHaveBeenCalled()
    await send(conv, 'd')
    expect(b.send).toHaveBeenCalled()
  })

  it('Agent Manager: a tarefa (id) recebe erro claro, sem sessão nova; a mensagem do usuário segue normal', async () => {
    const conv = 'mcp-manager'
    config(conv)
    const t = mcpInbound.registry.create(conv, 'plano', 'gpt-6-sol')
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', planning: { slug: 'checkout' } })
    const manager = sessionsOf(conv).at(-1)!
    expect(manager.opts.inboundMcp).toBeUndefined()
    const before = spy.sessions.length
    await expect(send(conv, 'plano', t.id)).rejects.toThrow(/Agent Manager/)
    expect(spy.sessions.length).toBe(before)
    expect(mcpInbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: expect.stringMatching(/Agent Manager/) })
    await send(conv, 'separa as etapas')
    expect(manager.send).toHaveBeenCalledTimes(1)
    expect(manager.pinModel).toHaveBeenLastCalledWith(false)
  })

  it('corrida (reprodução do crítico): agentStart no meio da troca espera a vez — uma sessão viva só, a substituída com dispose', async () => {
    const conv = 'mcp-corrida'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    const [a] = sessionsOf(conv)
    config(conv)
    const t = mcpInbound.registry.create(conv, 'T', 'gpt-6-sol')
    let releaseB!: (ok: boolean) => void
    spy.startResults.push(new Promise<boolean>((r) => (releaseB = r)))
    const sending = send(conv, 'T', t.id)
    await vi.waitFor(() => expect(sessionsOf(conv)).toHaveLength(2))
    const b = sessionsOf(conv)[1]
    // Outro agentStart (a tela reconectando), com o lease dele demorando.
    let openGate!: () => void
    leaseGate.p = new Promise<void>((r) => (openGate = r))
    const other = call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    await new Promise((r) => setTimeout(r, 20))
    // Ele espera a troca: nada foi descartado nem criado no meio dela.
    expect(a.dispose).not.toHaveBeenCalled()
    expect(sessionsOf(conv)).toHaveLength(2)
    releaseB(true)
    await sending
    expect(b.send).toHaveBeenCalledTimes(1)
    expect(b.pinModel).toHaveBeenLastCalledWith(true)
    leaseGate.p = null
    openGate()
    await other
    const all = sessionsOf(conv)
    expect(all).toHaveLength(3)
    const [, , c] = all
    // Toda substituída com dispose; viva, só a última.
    expect(a.dispose).toHaveBeenCalled()
    expect(b.dispose).toHaveBeenCalled()
    expect(c.dispose).not.toHaveBeenCalled()
    expect(all.filter((s) => s.dispose.mock.calls.length === 0)).toEqual([c])
    // A conversa segue: a mensagem seguinte vai para a sessão viva (ou a refeita
    // dela no modelo da conversa), e de novo só uma fica viva.
    await send(conv, 'oi')
    const last = sessionsOf(conv).at(-1)!
    expect(last.send).toHaveBeenCalledTimes(1)
    expect(b.send).toHaveBeenCalledTimes(1)
    expect(sessionsOf(conv).filter((s) => s.dispose.mock.calls.length === 0)).toEqual([last])
  })

  it('conversa descartada durante a troca: a nova é descartada, nada fica vivo e a tarefa vira erro', async () => {
    const conv = 'mcp-corrida-dispose'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    const [a] = sessionsOf(conv)
    config(conv)
    const t = mcpInbound.registry.create(conv, 'T', 'gpt-6-sol')
    let release!: (ok: boolean) => void
    spy.startResults.push(new Promise<boolean>((r) => (release = r)))
    const sending = send(conv, 'T', t.id)
    await vi.waitFor(() => expect(sessionsOf(conv)).toHaveLength(2))
    const b = sessionsOf(conv)[1]
    await call(Channels.agentDispose, conv)
    release(true)
    await expect(sending).rejects.toThrow(/outra sessão assumiu/)
    expect(a.dispose).toHaveBeenCalled()
    expect(b.dispose).toHaveBeenCalled()
    expect(b.send).not.toHaveBeenCalled()
    expect(mcpInbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: expect.stringMatching(/outra sessão assumiu/) })
  })

  it('troca que falha não mexe no estado da sessão antiga (origem do Automático)', async () => {
    const conv = 'mcp-falha-estado'
    vi.mocked(resolveAutoStart).mockReset().mockResolvedValue(decide('claude-sonnet-5-5', false, 'antiga'))
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', effort: AUTO_EFFORT })
    config(conv)
    const t = mcpInbound.registry.create(conv, 'T', 'gpt-6-sol')
    vi.mocked(resolveAutoStart).mockResolvedValue(decide('gpt-6-sol', false, 'da-troca'))
    spy.startResults.push(false)
    await expect(send(conv, 'T', t.id)).rejects.toThrow(/trocar o modelo/)
    // O próximo start da conversa vê a origem da sessão que ficou, não a da troca que falhou.
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5', effort: AUTO_EFFORT })
    expect(vi.mocked(resolveAutoStart).mock.calls.at(-1)?.[0]).toMatchObject({ live: { tag: 'antiga' } })
  })

  it('reconexão no meio do turno da tarefa: ela termina em erro (sessão trocada) e o "Tentar de novo" é recusado', async () => {
    const conv = 'mcp-tentar-de-novo'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    config(conv)
    const t = mcpInbound.registry.create(conv, 'T', 'gpt-6-sol')
    await send(conv, 'T', t.id)
    const task = sessionsOf(conv).at(-1)!
    expect(task.opts.model).toBe('gpt-6-sol')
    // A tela reconecta no meio do turno (sem result): sessão nova, no modelo da CONVERSA.
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    const fresh = sessionsOf(conv).at(-1)!
    expect(fresh).not.toBe(task)
    expect(task.dispose).toHaveBeenCalled()
    expect(fresh.opts.model).toBe('claude-sonnet-5-5')
    expect(mcpInbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: MCP_SESSION_REPLACED })
    // "Tentar de novo" com o id: recusado com a marca; nada sobe, nada é gravado nem enviado.
    const before = spy.sessions.length
    for (const fn of Object.values(spy.note)) fn.mockClear()
    await expect(send(conv, 'T', t.id, [file])).rejects.toThrow(MCP_TASK_GONE_MARK)
    expect(spy.sessions.length).toBe(before)
    expect(fresh.send).not.toHaveBeenCalled()
    for (const fn of Object.values(spy.note)) expect(fn).not.toHaveBeenCalled()
    expect(mcpInbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: MCP_SESSION_REPLACED })
  })

  it('529 no turno da tarefa gpt: tarefa em erro, retomada automática recusada, nenhuma sessão em outro modelo', async () => {
    const conv = 'mcp-retry'
    await call(Channels.agentStart, { convId: conv, cwd, model: 'claude-sonnet-5-5' })
    config(conv)
    const t = mcpInbound.registry.create(conv, 'T', 'gpt-6-sol')
    await send(conv, 'T', t.id)
    const task = sessionsOf(conv).at(-1)!
    expect(task.pinModel).toHaveBeenLastCalledWith(true)
    task.emit({ kind: 'result', id: 'r', isError: true, text: 'API Error: 529 overloaded', durationMs: 1 })
    expect(mcpInbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: 'API Error: 529 overloaded' })
    // A retomada automática (sonda 2 do crítico): recusada, sem subir sessão nenhuma.
    const before = spy.sessions.length
    await expect(send(conv, 'Continue', undefined, [], 'recovery')).rejects.toThrow(/não repete sozinho/)
    expect(spy.sessions.length).toBe(before)
    expect(task.send).toHaveBeenCalledTimes(1)
    // O usuário digita: volta ao modelo da conversa, sem pin; a tarefa segue em erro, com o motivo dela.
    await send(conv, 'outra coisa')
    const user = sessionsOf(conv).at(-1)!
    expect(user.opts.model).toBe('claude-sonnet-5-5')
    expect(user.pinModel).toHaveBeenLastCalledWith(false)
    user.emit({ kind: 'result', id: 'r2', isError: false, text: 'resposta do usuário', durationMs: 1 })
    expect(mcpInbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: 'API Error: 529 overloaded' })
    expect(mcpInbound.registry.get(t.id)?.resposta).toBeUndefined()
    // E depois de um turno do usuário, a retomada automática volta a valer (mensagem do usuário).
    await send(conv, 'Continue', undefined, [], 'recovery')
    expect(user.send).toHaveBeenCalledTimes(2)
  })

  it('conversa comum: agent:send não refaz sessão nem fixa modelo por tarefa', async () => {
    await call(Channels.agentStart, { convId: 'comum-2', cwd, model: 'claude-sonnet-5-5' })
    const before = spy.sessions.length
    await send('comum-2', 'oi')
    expect(spy.sessions.length).toBe(before)
    expect(sessionsOf('comum-2')[0].pinModel).toHaveBeenLastCalledWith(false)
  })
})
