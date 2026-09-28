import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { StartAgentOptions } from '../../shared/ipc'
import { MCP_NO_AUTO_RETRY, MCP_PLANNING_REFUSED, MCP_TASK_MODEL } from './mcpConstants'
import { McpInbound, MODELS_WAIT_MS, type LiveSessionState, type McpSend } from './mcpInbound'
import { SUPERSEDED } from './mcpTasks'
import { applyInboundMcpOptions } from './mcpSessionOptions'
import { secondInstanceReveal, wantsMinimized } from './windowStartup'

const base: StartAgentOptions = { convId: 'c1', cwd: 'C:\\p', model: 'claude-sonnet-5-5', effort: 'medium' }
/** Envio como o index o monta: texto, id da tarefa do item (se for de tarefa) e tipo. */
const send = (text: string, taskId?: string, kind?: McpSend['kind']): McpSend => ({
  text,
  ...(taskId ? { taskId } : {}),
  ...(kind ? { kind } : {})
})

describe('applyInboundMcpOptions', () => {
  it('conversa normal: continua pedindo aprovação, e o inboundMcp do renderer é descartado', () => {
    const forged = { ...base, inboundMcp: { cliente: 'x', servers: { evil: { command: 'calc.exe', args: [], env: {} } } } }
    const out = applyInboundMcpOptions(forged, undefined)
    expect(out).toEqual(base)
    expect(out.skipPermissions).toBeUndefined()
  })

  it('conversa MCP: servidores do chamador, "Permitir tudo" e o modelo fixo, só nela', () => {
    const servers = { forgia: { command: 'forgia.exe', args: ['mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } } }
    const out = applyInboundMcpOptions(base, { cliente: 'Forgia', mcpServers: servers })
    expect(out).toEqual({ ...base, model: MCP_TASK_MODEL, skipPermissions: true, inboundMcp: { cliente: 'Forgia', servers } })
    expect(MCP_TASK_MODEL).toBe('claude-opus-5-5')
  })

  it('modelo da tarefa: esforço recortado ao teto do modelo e modo rápido só onde existe', () => {
    const config = { cliente: 'Forgia', mcpServers: {} }
    const ollama = applyInboundMcpOptions({ ...base, fastMode: true }, config, 'kimi-k3:cloud')
    expect(ollama).toMatchObject({ model: 'kimi-k3:cloud', fastMode: false, effort: 'medium' })
    expect(applyInboundMcpOptions({ ...base, fastMode: true }, config, 'gpt-6-sol')).toMatchObject({ model: 'gpt-6-sol', fastMode: true })
    expect(applyInboundMcpOptions({ ...base, effort: 'auto' }, config, 'gpt-6-sol').effort).toBe('auto')
  })
})

describe('--minimizado', () => {
  it('reconhece a flag', () => {
    expect(wantsMinimized(['Agent Code.exe', '--minimizado'])).toBe(true)
    expect(wantsMinimized(['Agent Code.exe', '--MINIMIZADO '])).toBe(true)
    expect(wantsMinimized(['Agent Code.exe'])).toBe(false)
  })
  it('segunda instância: sem a flag traz; com ela só sem login; desconhecido confere', () => {
    expect(secondInstanceReveal(['x'], true)).toBe('reveal')
    expect(secondInstanceReveal(['x', '--minimizado'], true)).toBe('stay')
    expect(secondInstanceReveal(['x', '--minimizado'], false)).toBe('reveal')
    expect(secondInstanceReveal(['x', '--minimizado'], null)).toBe('check')
  })
})

describe('McpInbound', () => {
  function make() {
    const deps = {
      version: '1.0.0',
      conversationExists: async () => false,
      deliverToRenderer: vi.fn(),
      dropQueuedInRenderer: vi.fn(),
      interruptInRenderer: vi.fn(),
      answerInRenderer: vi.fn(),
      models: { now: () => ['claude-opus-5-5', 'gpt-6-sol'], fresh: async () => ['claude-opus-5-5', 'gpt-6-sol'] }
    }
    return { inbound: new McpInbound(deps), deps }
  }

  it('GET /agent-code: recursos, modelos aceitos agora e o padrão (sem segredo)', async () => {
    const { inbound } = make()
    expect(await inbound.info()).toEqual({ recursos: ['modelo', 'imagens'], modelos: ['claude-opus-5-5', 'gpt-6-sol'], modelo_padrao: MCP_TASK_MODEL })
  })

  describe('GET e tools/call: a MESMA lista de modelos, inclusive na partida', () => {
    const call = (inbound: McpInbound, args: Record<string, unknown>) =>
      (inbound as unknown as { server: { deps: { tools: { call: (n: string, a: unknown) => Promise<{ value: Record<string, unknown>; isError?: boolean }> } } } })
        .server.deps.tools.call('agent_code_enviar', { prompt: 'x', cliente: 'Forgia', projeto: tmpdir(), ...args })

    it('login do ChatGPT ainda carregando além do teto: os dois sem os GPT (nunca um anuncia e o outro recusa)', async () => {
      const inbound = new McpInbound({
        ...make().deps,
        modelsWaitMs: 10,
        models: { now: () => ['claude-opus-5-5'], fresh: () => new Promise<string[]>(() => undefined) }
      })
      expect((await inbound.info()).modelos).toEqual(['claude-opus-5-5'])
      const r = await call(inbound, { modelo: 'gpt-6-sol' })
      expect(r.isError).toBe(true)
      expect(r.value.modelos).toEqual(['claude-opus-5-5'])
    })

    it('carga que termina dentro do teto: os dois já com os GPT', async () => {
      let loaded!: (v: string[]) => void
      const fresh = new Promise<string[]>((resolve) => (loaded = resolve))
      const inbound = new McpInbound({
        ...make().deps,
        modelsWaitMs: 1000,
        models: { now: () => ['claude-opus-5-5'], fresh: () => fresh }
      })
      setTimeout(() => loaded(['claude-opus-5-5', 'gpt-6-sol']), 20)
      expect((await inbound.info()).modelos).toEqual(['claude-opus-5-5', 'gpt-6-sol'])
      const r = await call(inbound, { modelo: 'gpt-6-sol' })
      expect(r.isError).toBeUndefined()
      expect(r.value.tarefa_id).toBeTruthy()
    })

    it('o teto padrão cabe na varredura do Forgia (~300 ms por porta)', () => {
      expect(MODELS_WAIT_MS).toBeLessThan(300)
    })
  })

  describe('modelo da tarefa x estado REAL da sessão', () => {
    const opts: StartAgentOptions = { convId: 'c1', cwd: 'C:\\p', model: 'claude-opus-5-5', resume: 'sdk-0' }
    const live = (model: string, mcp = true): LiveSessionState => ({ model, mcp })

    it('o envio com o id da tarefa refaz a sessão no modelo dela; a seguinte, idem, retomando a conversa do SDK', () => {
      const { inbound } = make()
      const reg = inbound.registry
      inbound.sessionOptions(opts)
      reg.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
      const um = reg.create('c1', 'um', 'gpt-6-sol')
      const redo = inbound.restartForSend('c1', send('um', um.id), live('claude-opus-5-5'))
      expect(inbound.sessionOptions(redo!).model).toBe('gpt-6-sol')
      // Mesmo modelo e config MCP na sessão viva: nada a refazer.
      expect(inbound.restartForSend('c1', send('um', um.id), live('gpt-6-sol'))).toBeNull()
      inbound.onAgentSend('c1', send('um', um.id))
      inbound.onEvent('c1', { kind: 'system', sessionId: 'sdk-1', model: 'gpt-6-sol', cwd: 'C:\\p', tools: [] })
      inbound.onEvent('c1', { kind: 'result', text: 'ok', isError: false } as never)
      // Tarefa seguinte sem modelo: o padrão, retomando a mesma conversa do SDK.
      const dois = reg.create('c1', 'dois')
      // O autoPrompt vai com a mensagem que está saindo e a cauda REAL da conversa.
      expect(inbound.restartForSend('c1', send('dois', dois.id), live('gpt-6-sol'))).toEqual({
        ...opts,
        resume: 'sdk-1',
        autoPrompt: { message: 'dois', history: [{ who: 'user', text: 'um' }, { who: 'agent', text: 'ok' }] }
      })
      expect(inbound.sessionOptions({ ...opts, resume: 'sdk-1' }).model).toBe('claude-opus-5-5')
      expect(inbound.restartForSend('c1', send('dois', dois.id), live(MCP_TASK_MODEL))).toBeNull()
      // Conversa comum: nada disso vale.
      expect(inbound.sessionOptions({ ...opts, convId: 'c2' }).model).toBe('claude-opus-5-5')
      expect(inbound.restartForSend('c2', send('x', dois.id), live('gpt-6-sol', false))).toBeNull()
    })

    it('sessão aberta ANTES da config MCP (live vazio): a tarefa refaz a sessão mesmo no mesmo modelo', () => {
      const { inbound } = make()
      // O usuário abriu a conversa (app reiniciado): sessão sem config.
      const plain = inbound.sessionOptions({ ...opts, model: 'claude-sonnet-5-5' })
      expect(plain.inboundMcp).toBeUndefined()
      // O Forgia manda conversa_id + modelo: config nova, tarefa na fila.
      inbound.registry.setConfig('c1', { cliente: 'Forgia', mcpServers: { forgia: { command: 'f.exe', args: [], env: {} } } })
      const peca = inbound.registry.create('c1', 'peça', 'claude-opus-5-5')
      const redo = inbound.restartForSend('c1', send('peça', peca.id), live('claude-sonnet-5-5', false))
      expect(redo).toMatchObject({ convId: 'c1', model: 'claude-sonnet-5-5' })
      const started = inbound.sessionOptions(redo!)
      expect(started).toMatchObject({ model: 'claude-opus-5-5', skipPermissions: true })
      expect(started.inboundMcp?.servers.forgia.command).toBe('f.exe')
      // Mesmo modelo, mas a sessão viva não tem os mcp_servers: refaz também.
      const outra = inbound.registry.create('c1', 'outra', MCP_TASK_MODEL)
      inbound.onAgentSend('c1', send('peça', peca.id))
      inbound.onEvent('c1', { kind: 'result', text: 'ok', isError: false } as never)
      expect(inbound.restartForSend('c1', send('outra', outra.id), live(MCP_TASK_MODEL, false))).not.toBeNull()
      expect(inbound.restartForSend('c1', send('outra', outra.id), live(MCP_TASK_MODEL, true))).toBeNull()
    })

    it('"vale para esta tarefa": a mensagem seguinte do usuário volta ao modelo da conversa', () => {
      const { inbound } = make()
      inbound.sessionOptions({ ...opts, model: 'claude-sonnet-5-5' })
      inbound.registry.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
      const t = inbound.registry.create('c1', 'tarefa', 'gpt-6-sol')
      const redo = inbound.restartForSend('c1', send('tarefa', t.id), live('claude-sonnet-5-5', false))!
      expect(inbound.sessionOptions(redo).model).toBe('gpt-6-sol')
      inbound.onAgentSend('c1', send('tarefa', t.id))
      // Retomada automática (`recovery`) depois de turno de tarefa: recusada (regra 2).
      expect(inbound.refusal('c1', send('[continuação]', undefined, 'recovery'))).toBe(MCP_NO_AUTO_RETRY)
      expect(inbound.restartForSend('c1', send('[continuação]', undefined, 'recovery'), live('claude-sonnet-5-5'))).toBeNull()
      inbound.onEvent('c1', { kind: 'result', text: 'ok', isError: false } as never)
      // Tarefa acabou: a mensagem do usuário refaz a sessão no modelo da conversa.
      const back = inbound.restartForSend('c1', send('e agora?'), live('gpt-6-sol'))
      expect(back).toMatchObject({ model: 'claude-sonnet-5-5' })
      expect(inbound.sessionOptions(back!).model).toBe('claude-sonnet-5-5')
      expect(inbound.pinForSend('c1', send('e agora?'))).toBe(false)
      expect(inbound.restartForSend('c1', send('e agora?'), live('claude-sonnet-5-5'))).toBeNull()
      // Troca por cota numa mensagem do usuário: o modelo novo passa a ser o da conversa.
      inbound.onEvent('c1', { kind: 'provider-switch', id: 'p', fromModel: 'claude-sonnet-5-5', model: 'gpt-6-astra', fastMode: false, text: '' } as never)
      expect(inbound.restartForSend('c1', send('mais'), live('gpt-6-astra'))).toBeNull()
      // Automático e Agent Manager decidem o modelo na subida: nada a exigir.
      inbound.sessionOptions({ ...opts, model: 'auto' })
      expect(inbound.restartForSend('c1', send('oi'), live('gpt-6-sol'))).toBeNull()
    })

    it('fixa o modelo do turno só quando a tarefa pediu o modelo', () => {
      const { inbound } = make()
      inbound.registry.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
      const com = inbound.registry.create('c1', 'com', 'gpt-6-sol')
      const sem = inbound.registry.create('c1', 'sem')
      expect(inbound.pinForSend('c1', send('com', com.id))).toBe(true)
      inbound.onAgentSend('c1', send('com', com.id))
      inbound.onEvent('c1', { kind: 'result', text: 'ok', isError: false } as never)
      expect(inbound.pinForSend('c1', send('sem', sem.id))).toBe(false)
    })
  })

  describe('botão "agora" com tarefa MCP', () => {
    it('modelo diferente da sessão viva (ou sessão sem config MCP): recusa, e a tarefa continua na fila', () => {
      const { inbound } = make()
      inbound.sessionOptions({ convId: 'c1', cwd: 'C:\\p', model: 'claude-opus-5-5' })
      inbound.registry.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
      const t = inbound.registry.create('c1', 'ajuste', 'gpt-6-sol')
      expect(inbound.injectBlocked('c1', t.id, { model: 'claude-opus-5-5', mcp: true })).toMatch(/gpt-6-sol/)
      expect(inbound.injectBlocked('c1', t.id, { model: 'gpt-6-sol', mcp: false })).toMatch(/fila/)
      expect(inbound.registry.get(t.id)?.status).toBe('na_fila')
      // Depois, no agent:send (fim do turno), ela sai com a sessão trocada.
      expect(inbound.restartForSend('c1', send('ajuste', t.id), { model: 'claude-opus-5-5', mcp: true })).not.toBeNull()
    })

    it('mesmo modelo: entra no turno como hoje (e, com modelo pedido, fixa o modelo)', () => {
      const { inbound } = make()
      inbound.registry.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
      const t = inbound.registry.create('c1', 'ajuste', 'gpt-6-sol')
      expect(inbound.injectBlocked('c1', t.id, { model: 'gpt-6-sol', mcp: true })).toBeNull()
      expect(inbound.onInjected('c1', t.id)).toBe(true)
      expect(inbound.registry.get(t.id)?.status).toBe('rodando')
      // Item sem id (mensagem do usuário) e conversa comum: o "agora" de sempre.
      expect(inbound.injectBlocked('c1', undefined, { model: 'x', mcp: false })).toBeNull()
      expect(inbound.injectBlocked('c9', t.id, null)).toBeNull()
    })
  })

  describe('continuação 7b50df69: fila fora de ordem, erro transitório, Agent Manager', () => {
    const opts: StartAgentOptions = { convId: 'c1', cwd: 'C:\\p', model: 'claude-sonnet-5-5' }
    const live = (model: string, mcp = true): LiveSessionState => ({ model, mcp })

    it('"agora" recusado pôs a T2 antes da T1: cada uma casa pelo id e roda no seu modelo, com pin', () => {
      const { inbound } = make()
      const reg = inbound.registry
      inbound.sessionOptions(opts)
      reg.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
      const t1 = reg.create('c1', 'T1', 'claude-opus-5-5')
      const t2 = reg.create('c1', 'T2', 'gpt-6-sol')
      // A T2 sai primeiro: a sessão é refeita no modelo DELA, não no da cabeça (T1).
      const redo = inbound.restartForSend('c1', send('T2', t2.id), live('claude-sonnet-5-5'))
      expect(inbound.sessionOptions(redo!).model).toBe('gpt-6-sol')
      expect(inbound.pinForSend('c1', send('T2', t2.id))).toBe(true)
      inbound.onAgentSend('c1', send('T2', t2.id))
      expect(reg.get(t2.id)?.status).toBe('rodando')
      expect(reg.get(t1.id)?.status).toBe('na_fila')
      inbound.onEvent('c1', { kind: 'result', text: 'feito 2', isError: false } as never)
      expect(reg.get(t2.id)).toMatchObject({ status: 'concluida', resposta: 'feito 2' })
      // Depois a T1, no modelo dela.
      const redo1 = inbound.restartForSend('c1', send('T1', t1.id), live('gpt-6-sol'))
      expect(inbound.sessionOptions(redo1!).model).toBe('claude-opus-5-5')
      expect(inbound.pinForSend('c1', send('T1', t1.id))).toBe(true)
      inbound.onAgentSend('c1', send('T1', t1.id))
      expect(reg.get(t1.id)?.status).toBe('rodando')
      inbound.onEvent('c1', { kind: 'result', text: 'feito 1', isError: false } as never)
      expect(reg.get(t1.id)).toMatchObject({ status: 'concluida', resposta: 'feito 1' })
    })

    it('agentStart da tela nunca adivinha tarefa pela fila nem pelo texto: sobe no modelo da conversa', () => {
      const { inbound } = make()
      inbound.registry.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
      inbound.registry.create('c1', 'T1', 'claude-opus-5-5')
      inbound.registry.create('c1', 'T2', 'gpt-6-sol')
      expect(inbound.sessionOptions({ ...opts, autoPrompt: { message: 'T2' } }).model).toBe('claude-sonnet-5-5')
      const user = inbound.sessionOptions(opts)
      expect(user.model).toBe('claude-sonnet-5-5')
      expect(user.inboundMcp).toBeDefined()
    })

    it('erro transitório: a tarefa termina em erro com o motivo; a mensagem do usuário não herda modelo/pin nem a fecha', () => {
      const { inbound } = make()
      const reg = inbound.registry
      inbound.sessionOptions(opts)
      reg.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
      const t = reg.create('c1', 'tarefa', 'gpt-6-sol')
      inbound.onAgentSend('c1', send('tarefa', t.id))
      inbound.onEvent('c1', { kind: 'error', text: 'overloaded', retryable: true } as never)
      expect(reg.get(t.id)).toMatchObject({ status: 'erro', erro: 'overloaded' })
      // O usuário digita: modelo da conversa, sem pin.
      expect(inbound.restartForSend('c1', send('outra coisa'), live('gpt-6-sol'))).toMatchObject({ model: 'claude-sonnet-5-5' })
      expect(inbound.pinForSend('c1', send('outra coisa'))).toBe(false)
      inbound.onAgentSend('c1', send('outra coisa'))
      inbound.onEvent('c1', { kind: 'result', text: 'resposta do usuário', isError: false } as never)
      expect(reg.get(t.id)).toMatchObject({ status: 'erro', erro: 'overloaded' })
      expect(reg.get(t.id)?.resposta).toBeUndefined()
      expect(SUPERSEDED).toMatch(/outra mensagem/)
    })

    it('retomada automática (`recovery`): recusada depois de turno de tarefa, livre depois de turno do usuário', () => {
      const { inbound } = make()
      inbound.sessionOptions(opts)
      inbound.registry.setConfig('c1', { cliente: 'F', mcpServers: {} })
      const t = inbound.registry.create('c1', 'um', 'gpt-6-sol')
      inbound.onAgentSend('c1', send('um', t.id))
      inbound.onEvent('c1', { kind: 'result', text: 'API Error: 529 overloaded', isError: true } as never)
      const rec = send('[continuação]', undefined, 'recovery')
      expect(inbound.refusal('c1', rec)).toBe(MCP_NO_AUTO_RETRY)
      expect(inbound.restartForSend('c1', rec, live('gpt-6-sol'))).toBeNull()
      expect(inbound.isTaskSend('c1', rec)).toBe(false)
      inbound.onAgentSend('c1', send('oi'))
      expect(inbound.refusal('c1', rec)).toBeNull()
    })

    it('Agent Manager: tarefa (com id) recebe erro claro e vira erro; mensagem do usuário sobe como conversa comum', () => {
      const { inbound } = make()
      inbound.registry.setConfig('c1', { cliente: 'Forgia', mcpServers: {} })
      const t = inbound.registry.create('c1', 'plano', 'gpt-6-sol')
      // Mensagem do usuário no Manager (nenhuma tarefa pedida): sobe, sem a config MCP.
      const user = inbound.sessionOptions({ ...opts, planning: { slug: 'x' } })
      expect(user.inboundMcp).toBeUndefined()
      expect(user.skipPermissions).toBeUndefined()
      expect(inbound.registry.get(t.id)?.status).toBe('na_fila')
      // A tarefa (pelo id) exige a troca, e a troca no Manager é recusada.
      const redo = inbound.restartForSend('c1', send('plano', t.id), live('claude-sonnet-5-5', false))
      expect(() => inbound.sessionOptions(redo!)).toThrow(MCP_PLANNING_REFUSED)
      expect(inbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: MCP_PLANNING_REFUSED })
      // Conversa do Manager sem config MCP: nada muda.
      expect(inbound.sessionOptions({ ...opts, convId: 'c2', planning: { slug: 'x' } }).model).toBe('claude-sonnet-5-5')
    })
  })

  it('troca de modelo que falha: a tarefa vira erro', () => {
    const { inbound } = make()
    inbound.registry.setConfig('c1', { cliente: 'F', mcpServers: {} })
    const t = inbound.registry.create('c1', 'um', 'gpt-6-sol')
    inbound.failStart('c1', send('um', t.id), 'Não consegui trocar o modelo da conversa: x')
    expect(inbound.registry.get(t.id)).toMatchObject({ status: 'erro', erro: 'Não consegui trocar o modelo da conversa: x' })
  })

  it('prontidão: sem leitura ainda ou sem login → pronto:false, motivo:"login"', () => {
    const { inbound } = make()
    expect(inbound.readiness()).toEqual({ pronto: false, motivo: 'login' })
    expect(inbound.claudeReadyNow).toBeNull()
    inbound.setClaudeReady(true)
    expect(inbound.readiness()).toEqual({ pronto: true, motivo: null })
    inbound.setClaudeReady(false)
    expect(inbound.readiness()).toEqual({ pronto: false, motivo: 'login' })
  })

  it('entregas esperam o renderer ficar pronto (app abrindo, F5) e saem na ordem', async () => {
    const { inbound, deps } = make()
    const d1 = { taskId: 't1', convId: 'c1', text: 'um' }
    const d2 = { taskId: 't2', convId: 'c1', text: 'dois' }
    ;(inbound as unknown as { deliver: (d: unknown) => void }).deliver(d1)
    expect(deps.deliverToRenderer).not.toHaveBeenCalled()
    inbound.markRendererReady()
    expect(deps.deliverToRenderer.mock.calls.map((c) => c[0])).toEqual([d1])
    inbound.markRendererGone()
    ;(inbound as unknown as { deliver: (d: unknown) => void }).deliver(d2)
    expect(deps.deliverToRenderer).toHaveBeenCalledTimes(1)
    inbound.markRendererReady()
    expect(deps.deliverToRenderer.mock.calls.map((c) => c[0])).toEqual([d1, d2])
  })
})
