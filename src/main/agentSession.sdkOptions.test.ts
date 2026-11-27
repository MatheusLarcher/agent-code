// @vitest-environment node
// As Options que a sessão REAL entrega ao SDK, por família de modelo (`query` é
// dublê): o resumo ao vivo dos subagentes (`agentProgressSummaries`) só vai no
// Claude — em GPT, Ollama e DeepSeek seria um pedido extra a cada ~30 s, sem o
// cache do subagente.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserController } from './browserController'

const configState = vi.hoisted(() => ({
  ollama: { enabled: false, apiKey: '' },
  deepseek: { enabled: false, apiKey: '' },
  chromeControlEnabled: false as unknown
}))
const cacheState = vi.hoisted(() => ({ dir: '', memoriesDir: '', skillsDir: '', localDir: '' }))
vi.mock('./config', () => ({
  loadConfig: () => ({
    windowsControlEnabled: false,
    chromeControlEnabled: configState.chromeControlEnabled,
    memorySelector: 'typesafe',
    ollama: configState.ollama,
    deepseek: configState.deepseek,
    board: { requirePlan: true }
  })
}))
vi.mock('./store', () => ({ getCacheInfo: () => ({ ...cacheState }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => true }))
vi.mock('./codexProxy', () => ({
  ensureCodexProxyRunning: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:43210', secret: 'segredo-local-de-teste' })),
  FAST_MODE_TOKEN_SUFFIX: '+fast'
}))
vi.mock('./persistence/lifecycle', () => ({
  storageLifecycle: { repository: () => ({ countConversationsByProject: async () => [] }) }
}))
vi.mock('./projectOutline', () => ({ buildProjectOutline: async () => '' }))
vi.mock('./typesafe', () => ({
  typeSafeMemorySelectionActive: async () => false,
  selectMemoriesWithTypeSafe: async () => null
}))
vi.mock('./memory/memoryRuntime', () => ({
  memoryService: () => ({}),
  secretSink: () => null,
  secretVaultEnabled: () => false,
  readSecret: async () => null,
  readSecretsForPrompt: async () => []
}))
vi.mock('./tasks/taskRuntime', () => ({ taskLedger: () => ({}) }))

const queryMock = vi.hoisted(() => vi.fn())
const keepAlive = vi.hoisted(() => ({ on: false }))
const setMcpServersMock = vi.hoisted(() => vi.fn(async (_servers: Record<string, unknown>) => ({ added: ['rea'], removed: [], errors: {} })))
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@anthropic-ai/claude-agent-sdk')
  return {
    ...actual,
    query: (args: { options: unknown }) => {
      queryMock(args)
      return Object.assign((async function* () { if (keepAlive.on) await new Promise(() => {}) })(), { setMcpServers: setMcpServersMock, close: () => undefined, interrupt: async () => undefined })
    }
  }
})

import { AgentSession } from './agentSession'
import { CHROME_CONTROL_HINT, CHROME_ENABLED_NOTE } from './chromeBridge/hint'

let root = ''
let previousConfigDir: string | undefined
const sessions: AgentSession[] = []

/** As Options da única chamada ao `query` que a sessão fez ao subir. */
async function optionsFor(model: string): Promise<Record<string, unknown>> {
  const s = new AgentSession({ convId: 'c1', cwd: path.join(root, 'projeto'), model }, {} as BrowserController, vi.fn(), vi.fn(), vi.fn())
  sessions.push(s)
  await s.start()
  expect(queryMock).toHaveBeenCalledTimes(1)
  return (queryMock.mock.calls[0][0] as { options: Record<string, unknown> }).options
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agent-opcoes-sdk-'))
  // A pasta de config do CLI de mentira: GPT/Ollama/DeepSeek copiam dela para a raiz isolada.
  const home = path.join(root, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(path.join(home, 'settings.json'), '{}', 'utf8')
  previousConfigDir = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = home
  cacheState.dir = path.join(root, 'cache')
  cacheState.memoriesDir = path.join(root, 'cache', 'memories')
  cacheState.skillsDir = path.join(root, 'cache', 'skills')
  cacheState.localDir = path.join(root, 'local')
  await mkdir(cacheState.localDir, { recursive: true })
})
afterAll(async () => {
  if (previousConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = previousConfigDir
  await rm(root, { recursive: true, force: true })
})
beforeEach(() => {
  queryMock.mockClear()
  configState.ollama = { enabled: false, apiKey: '' }
  configState.deepseek = { enabled: false, apiKey: '' }
  configState.chromeControlEnabled = false
})
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
})

describe('AgentSession — Options por família de modelo', () => {
  it('Claude: resumo ao vivo dos subagentes ligado; sugestão do próximo prompt desligada', async () => {
    const options = await optionsFor('claude-opus-5-5')
    expect(options.agentProgressSummaries).toBe(true)
    expect(options).not.toHaveProperty('promptSuggestions')
  })

  it.each([
    ['GPT', 'gpt-6-sol', (): void => undefined],
    ['Ollama', 'gpt-oss:20b-cloud', (): void => { configState.ollama = { enabled: true, apiKey: 'chave-ollama' } }],
    ['DeepSeek', 'deepseek-flash', (): void => { configState.deepseek = { enabled: true, apiKey: 'chave-falsa' } }]
  ])('%s: as opções nem vão', async (_name, model, setup) => {
    setup()
    const options = await optionsFor(model)
    expect(options.model).toBe(model)
    expect(options).not.toHaveProperty('agentProgressSummaries')
    expect(options).not.toHaveProperty('promptSuggestions')
  })
})

describe('AgentSession — app_rodar_como_admin', () => {
  it('a sessão normal recebe a ferramenta (o Agent Manager não: agentSession.planning.test.ts)', async () => {
    const options = await optionsFor('claude-opus-5-5')
    const app = (options.mcpServers as Record<string, { instance?: { _registeredTools?: object } }>).app
    expect(Object.keys(app.instance?._registeredTools ?? {})).toContain('app_rodar_como_admin')
    expect((options.allowedTools as string[] | undefined) ?? []).not.toContain('mcp__app__app_rodar_como_admin')
  })
})

describe('AgentSession — Android sob demanda', () => {
  it('fora de projeto Android nasce sem o android; ligar acrescenta mantendo os da subida', async () => {
    setMcpServersMock.mockClear()
    keepAlive.on = true
    const options = await optionsFor('claude-opus-5-5')
    const servers = options.mcpServers as Record<string, unknown>
    expect(servers).not.toHaveProperty('android')
    const session = sessions[sessions.length - 1] as unknown as { enableAndroid: () => Promise<string> }
    expect(await session.enableAndroid()).toMatch(/Android ligado/)
    const sent = setMcpServersMock.mock.calls[0][0]
    expect(Object.keys(sent).sort()).toEqual([...Object.keys(servers), 'android'].sort())
    expect(await session.enableAndroid()).toMatch(/já estão ligadas/)
    keepAlive.on = false
  })

  it('em atendimento de suporte remoto, ligar o android repete o `remoto` (PC do cliente) e usa a fila do suporte', async () => {
    setMcpServersMock.mockClear()
    keepAlive.on = true
    const options = await optionsFor('claude-opus-5-5')
    const servers = options.mcpServers as Record<string, unknown>
    const naFila = vi.fn(<T,>(troca: () => Promise<T>) => troca())
    const session = sessions[sessions.length - 1] as unknown as { enableAndroid: () => Promise<string>; suporteLigacao: unknown }
    session.suporteLigacao = {
      aplicar: async () => undefined,
      desligar: () => undefined,
      naFila,
      servidores: () => ({ suporte: { type: 'sdk', name: 'suporte' }, remoto: { type: 'http', url: 'http://127.0.0.1:1/mcp' } })
    }
    expect(await session.enableAndroid()).toMatch(/Android ligado/)
    const sent = setMcpServersMock.mock.calls[0][0]
    expect(Object.keys(sent).sort()).toEqual([...new Set([...Object.keys(servers), 'suporte', 'remoto', 'android'])].sort())
    expect(sent.remoto).toMatchObject({ type: 'http' })
    expect(naFila).toHaveBeenCalledTimes(1)
    keepAlive.on = false
  })
})

describe('AgentSession — Chrome do usuário só com a permissão ligada', () => {
  const appendOf = (options: Record<string, unknown>): string => (options.systemPrompt as { append?: string }).append ?? ''

  it.each([false, undefined, 'true'])('chromeControlEnabled=%o (não é o booleano true): sem o servidor chrome e sem a dica', async (value) => {
    configState.chromeControlEnabled = value
    const options = await optionsFor('claude-opus-5-5')
    expect(options.mcpServers as Record<string, unknown>).not.toHaveProperty('chrome')
    expect(appendOf(options)).not.toContain(CHROME_CONTROL_HINT)
  })

  it('chromeControlEnabled=true: servidor chrome e dica, como antes', async () => {
    configState.chromeControlEnabled = true
    const options = await optionsFor('claude-opus-5-5')
    expect(options.mcpServers as Record<string, unknown>).toHaveProperty('chrome')
    expect(appendOf(options)).toContain(CHROME_CONTROL_HINT)
  })

  it('ligada com a conversa aberta: o chrome entra uma vez, repetindo os servidores da subida', async () => {
    setMcpServersMock.mockClear()
    keepAlive.on = true
    const options = await optionsFor('claude-opus-5-5')
    const servers = options.mcpServers as Record<string, unknown>
    const session = sessions[sessions.length - 1] as unknown as { enableChromeIfTurnedOn: () => Promise<string> }
    expect(await session.enableChromeIfTurnedOn()).toBe('') // ainda desligada
    expect(setMcpServersMock).not.toHaveBeenCalled()
    configState.chromeControlEnabled = true
    expect(await session.enableChromeIfTurnedOn()).toBe(CHROME_ENABLED_NOTE)
    const sent = setMcpServersMock.mock.calls[0][0]
    expect(Object.keys(sent).sort()).toEqual([...Object.keys(servers), 'chrome'].sort())
    expect(await session.enableChromeIfTurnedOn()).toBe('') // já ligado
    expect(setMcpServersMock).toHaveBeenCalledTimes(1)
    keepAlive.on = false
  })
})

describe('AgentSession — canUseTool: resposta do usuário não é erro', () => {
  it('AskUserQuestion respondida → tool-result com isError=false; erro de outra ferramenta continua erro', async () => {
    const sink = vi.fn()
    const ask = vi.fn()
    const s = new AgentSession({ convId: 'c1', cwd: path.join(root, 'projeto'), model: 'claude-opus-5-5' }, {} as BrowserController, sink, ask, vi.fn())
    sessions.push(s)
    await s.start()
    type CanUse = (n: string, i: Record<string, unknown>, o: { signal: AbortSignal; toolUseID: string }) => Promise<{ behavior: string }>
    const canUse = (queryMock.mock.calls[0][0] as { options: { canUseTool: CanUse } }).options.canUseTool
    const questions = [{ header: 'Lib', question: 'Qual lib usar?', multiSelect: false, options: [{ label: 'Zod', description: '' }, { label: 'Yup', description: '' }] }]
    const pending = canUse('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 'pergunta' })
    s.resolvePermission({ id: ask.mock.calls[0][0].id, behavior: 'allow', answers: [{ header: 'Lib', question: 'Qual lib usar?', selected: ['Zod'] }] })
    expect((await pending).behavior).toBe('deny') // o SDK devolve o tool_result com is_error=true
    const toolResult = (id: string, text: string): unknown => ({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] }
    })
    const handle = (m: unknown): void => (s as unknown as { handleMessage(m: unknown): void }).handleMessage(m)
    handle(toolResult('pergunta', 'The user answered your question(s):\nLib: Zod'))
    handle(toolResult('bash-1', 'Exit code 1'))
    const results = sink.mock.calls.map((c) => c[0]).filter((e: { kind?: string }) => e?.kind === 'tool-result')
    expect(results).toEqual([
      expect.objectContaining({ toolUseId: 'pergunta', isError: false }),
      expect.objectContaining({ toolUseId: 'bash-1', isError: true })
    ])
  })
})

describe('AgentSession — rea (engenharia reversa) sob demanda', () => {
  it('a sessão nasce sem o rea; ligar repete os servidores da subida e acrescenta o rea', async () => {
    setMcpServersMock.mockClear()
    keepAlive.on = true // sessão viva: o stream não termina
    const options = await optionsFor('claude-opus-5-5')
    const servers = options.mcpServers as Record<string, unknown>
    expect(servers).not.toHaveProperty('rea')
    expect(servers).toHaveProperty('app')
    const session = sessions[sessions.length - 1] as unknown as { enableRea: () => Promise<string> }
    const first = await session.enableRea()
    if (/não está instalado/.test(first)) return // cópia sem o rea-agents: nada a ligar
    expect(first).toMatch(/Rea ligado/)
    const sent = setMcpServersMock.mock.calls[0][0] as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual([...Object.keys(servers), 'rea'].sort())
    expect(await session.enableRea()).toMatch(/já está ligado/)
    expect(setMcpServersMock).toHaveBeenCalledTimes(1)
    keepAlive.on = false
  })
})
