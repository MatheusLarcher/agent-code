// @vitest-environment node
// O catálogo de skills vai UMA vez ao modelo: a listagem do próprio SDK (que
// recebe `skills: 'all'`) já leva nome e descrição de cada skill; o app manda só
// a regra de uso, e depois só o que mudou. Antes, o mesmo catálogo ia nas duas.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserController } from './browserController'

const cacheState = vi.hoisted(() => ({ dir: '', memoriesDir: '', skillsDir: '', localDir: '' }))
vi.mock('./config', () => ({
  loadConfig: () => ({
    windowsControlEnabled: false,
    chromeControlEnabled: false,
    memorySelector: 'typesafe',
    ollama: { enabled: false, apiKey: '' },
    deepseek: { enabled: false, apiKey: '' },
    kimi: { enabled: false, apiKey: '', region: 'intl', contextWindow: 262_144, models: [] },
    externalOrgInstructions: ''
  })
}))
vi.mock('./store', () => ({ getCacheInfo: () => ({ ...cacheState }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => true }))
vi.mock('./codexProxy', () => ({
  ensureCodexProxyRunning: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:43210', secret: 'segredo-local-de-teste' })),
  FAST_MODE_TOKEN_SUFFIX: '+fast'
}))
vi.mock('./kimi/kimiRouter', () => ({ ensureKimiRouterRunning: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:45678/x' })) }))
vi.mock('./persistence/lifecycle', () => ({
  storageLifecycle: { repository: () => ({ countConversationsByProject: async () => [], loadConversations: async () => [] }) }
}))
vi.mock('./projectOutline', () => ({ buildProjectOutline: async () => '' }))
vi.mock('./typesafe', () => ({
  typeSafeMemorySelectionActive: async () => false,
  selectMemoriesWithTypeSafe: async () => null
}))
vi.mock('./memorySelectionHaiku', async () => ({
  ...(await vi.importActual<typeof import('./memorySelectionHaiku')>('./memorySelectionHaiku')),
  selectMemoriesWithHaiku: async () => null
}))
vi.mock('./memory/memoryRuntime', async () => ({
  ...(await vi.importActual<typeof import('./memory/memoryRuntime')>('./memory/memoryRuntime')),
  readSecretsForPrompt: async () => []
}))
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

const DESCRIPTION = 'editar qualquer arquivo STL ou 3MF'
let root = ''

afterEach(async () => {
  queryMock.mockReset()
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

const count = (text: string, needle: string): number => text.split(needle).length - 1

describe('catálogo de skills uma vez só', () => {
  it('o que vai ao SDK (system prompt + mensagens) não repete nome nem descrição da listagem do SDK', async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-catalog-once-'))
    const project = join(root, 'projeto')
    cacheState.dir = join(root, 'cache')
    cacheState.skillsDir = join(root, 'cache', 'skills')
    cacheState.memoriesDir = join(root, 'cache', 'memories')
    cacheState.localDir = join(root, 'local')
    const skillDir = join(project, '.claude', 'skills', 'modelar')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), `---\nname: modelar\ndescription: ${DESCRIPTION}\n---\n\ncorpo`, 'utf8')

    const s = new AgentSession(
      { convId: 'c1', cwd: project, model: 'gpt-6-sol' },
      {} as BrowserController,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      { appRoot: project, userHome: join(root, 'home') }
    )
    await s.start()
    const options = (queryMock.mock.calls.at(-1)![0] as { options: Record<string, unknown> }).options
    // A listagem do SDK é a única fonte de nome + descrição.
    expect(options.skills).toBe('all')

    const reloadSkills = vi.fn(async () => ({ skills: [{ name: 'modelar', description: DESCRIPTION, argumentHint: '' }] }))
    ;(s as unknown as { q: { reloadSkills: typeof reloadSkills } }).q = { reloadSkills }
    await s.send('primeiro pedido')
    await s.send('segundo pedido')

    const messages = (s as unknown as { input: { values: Array<{ message: { content: unknown } }> } }).input.values
    const sent = [
      (options.systemPrompt as { append: string }).append,
      ...messages.map((m) => (typeof m.message.content === 'string' ? m.message.content : JSON.stringify(m.message.content)))
    ].join('\n')

    expect(String(messages[0].message.content)).toContain('[SKILL_CATALOG_UPDATE]')
    expect(count(sent, '[SKILL_CATALOG_UPDATE]')).toBe(1)
    expect(count(sent, 'FILESYSTEM SKILLS')).toBe(1)
    expect(sent).toContain('FILESYSTEM SKILLS: 1 skills are loaded in the Skill tool')
    expect(count(sent, DESCRIPTION)).toBe(0)
    expect(count(sent, '/modelar')).toBe(0)
    expect(sent).not.toContain('SKILL.md')
  })
})
