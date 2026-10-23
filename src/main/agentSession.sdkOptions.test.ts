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
  deepseek: { enabled: false, apiKey: '' }
}))
const cacheState = vi.hoisted(() => ({ dir: '', memoriesDir: '', skillsDir: '', localDir: '' }))
vi.mock('./config', () => ({
  loadConfig: () => ({
    windowsControlEnabled: false,
    chromeControlEnabled: false,
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
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@anthropic-ai/claude-agent-sdk')
  return {
    ...actual,
    query: (args: { options: unknown }) => {
      queryMock(args)
      return (async function* () {})()
    }
  }
})

import { AgentSession } from './agentSession'

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
})
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
})

describe('AgentSession — Options por família de modelo', () => {
  it('Claude: resumo ao vivo dos subagentes e sugestão do próximo prompt ligados', async () => {
    const options = await optionsFor('claude-opus-5-5')
    expect(options.agentProgressSummaries).toBe(true)
    expect(options.promptSuggestions).toBe(true)
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
