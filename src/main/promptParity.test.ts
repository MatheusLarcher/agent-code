// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OPENAI_MODELS, OLLAMA_MODELS, CONTEXT_LIMITS } from '../shared/ipc'
import { toCodexRequest, toCodexWireRequest } from './codexProtocol'

const capture = vi.hoisted(() => ({ queries: [] as Array<{ options: Record<string, unknown>; prompt: { values: Array<{ message: { content: string } }> } }> }))
// `typesafe` desligado: o contrato de prompt verificado aqui é o de sempre —
// catálogo no system prompt e excertos lexicais no contexto vivo.
vi.mock('./config', () => ({ loadConfig: () => ({ windowsControlEnabled: false, ollama: { apiKey: 'synthetic', enabled: true }, typesafe: { enabled: false, apiKey: '', minConfidence: 0.2 } }) }))
vi.mock('./codexAuth', () => ({ isCodexConnected: () => true }))
vi.mock('./codexProxy', () => ({ ensureCodexProxyRunning: async () => ({ baseUrl: 'http://127.0.0.1:1', secret: 'test' }), FAST_MODE_TOKEN_SUFFIX: '+fast' }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ dir: '/cache', skillsDir: '/cache/skills', memoriesDir: '/cache/memories' }) }))
vi.mock('./projectOutline', () => ({ buildProjectOutline: async () => '[PROJECT_DOCS_CONTEXT]\nDOC_SENTINEL\n[/PROJECT_DOCS_CONTEXT]' }))
vi.mock('./skillManager', () => ({ ensureNativeSkillRoot: () => ({ root: '/native', errors: [] }) }))
vi.mock('./memoryIndex', async (original) => ({
  ...await original<typeof import('./memoryIndex')>(),
  memoryCatalogFilesystemVersion: () => 'memory-v1',
  createMemoryCatalogSnapshot: () => ({ version: 'memory-v1', filesystemVersion: 'memory-v1', catalog: 'MEMORY_SENTINEL' }),
  renderMemoryCatalogUpdate: () => 'MEMORY_SENTINEL',
  buildDynamicMemoryContext: () => 'MEMORY_EXCERPT_SENTINEL'
}))
vi.mock('./skillDiscovery', async (original) => ({
  ...await original<typeof import('./skillDiscovery')>(),
  skillCatalogFilesystemVersion: () => 'skills-v1',
  discoverSkills: () => [{ name: 'probe', description: 'SKILL_SENTINEL', skillFile: '/project/.claude/skills/probe/SKILL.md', root: '/project', source: 'project-claude', native: true, modifiedAtMs: 1, sizeBytes: 1 }]
}))
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => {
  const { AsyncQueue } = await import('./asyncQueue')
  return {
    ...await original<typeof import('@anthropic-ai/claude-agent-sdk')>(),
    query: (args: typeof capture.queries[number]) => {
      capture.queries.push(args)
      const events = new AsyncQueue()
      return { [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](), close: () => events.close(), reloadSkills: async () => ({ skills: [{ name: 'probe' }] }) }
    }
  }
})
import { AgentSession } from './agentSession'
import type { BrowserController } from './browserController'

afterEach(() => { vi.useRealTimers(); capture.queries = [] })
describe('provider-neutral prompt contract', () => {
  it('restores loop budget and tool approvals without starting a new loop on provider continuation', async () => {
    const ask = vi.fn()
    const session = new AgentSession({ convId: 'parity', cwd: '/project', model: 'gpt-6-astra', loopEnabled: true }, {} as BrowserController, () => {}, ask, () => {})
    try {
      await session.start()
      const state = { approvedTools: ['Write'], loopActive: true, loopCycles: 17, loopLimit: 100, loopScheduledThisIteration: false }
      session.restoreContinuation(state)
      await session.send('Continue', undefined, 'continuation-id', 'pc', 'recovery')
      expect(session.continuationState()).toEqual(state)
      expect(capture.queries.at(-1)!.prompt.values[0].message.content).not.toMatch(/^\/loop/)
      await (session as unknown as { handlePermission(name: string, input: unknown): Promise<unknown> }).handlePermission('Write', { file_path: '/project/a.txt', content: 'ok' })
      expect(ask).not.toHaveBeenCalled()
    } finally { session.dispose() }
  })
  it('all selectable models get one identical live docs/memory contract while persisted user history remains lean', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-05T12:00:00Z'))
    const models = [...Object.keys(CONTEXT_LIMITS).filter((m) => m.startsWith('claude-')), ...OPENAI_MODELS.map((m) => m.id), ...OLLAMA_MODELS.map((m) => m.id)]
    let expected: unknown
    for (const model of models) {
      const session = new AgentSession({ convId: 'parity', cwd: '/project', model }, {} as BrowserController, () => {}, () => {}, () => {})
      try {
        expect(await session.start()).toBe(true)
        await session.send('USER_SENTINEL\n[Anexo: /project/file.pdf]')
        const args = capture.queries.at(-1)!
        const content = args.prompt.values[0].message.content
        const hook = (args.options.hooks as { UserPromptSubmit: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> }).UserPromptSubmit[0].hooks[0]
        const live = await hook({ hook_event_name: 'UserPromptSubmit' })
        const contract = { system: args.options.systemPrompt, content, live, skills: args.options.skills, sources: args.options.settingSources, directories: args.options.additionalDirectories }
        expected ??= contract
        expect(contract, model).toEqual(expected)
        expect(JSON.stringify(contract)).toContain('MEMORY_SENTINEL')
        expect(JSON.stringify(live)).toContain('DOC_SENTINEL')
        expect(JSON.stringify(live)).toContain('MEMORY_EXCERPT_SENTINEL')
        expect(content).not.toContain('DOC_SENTINEL')
        expect(content).toContain('SKILL_SENTINEL')
        expect(content).toContain('USER_SENTINEL')
        if (model.startsWith('gpt-') || OLLAMA_MODELS.some((m) => m.id === model)) {
          expect(args.options.env).toMatchObject({ CLAUDE_CODE_SUBAGENT_MODEL: model })
        }
      } finally { session.dispose() }
    }
  })

  it.each(OPENAI_MODELS.map((m) => m.id))('%s preserves instructions, user text, image and tool schema in the actual wire adapter', (model) => {
    const system = 'APP_INSTRUCTIONS\nMEMORY_SENTINEL\nSKILL_SENTINEL'
    const user = 'DOC_SENTINEL\nUSER_SENTINEL'
    const parameters = { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }
    const wire = toCodexWireRequest(toCodexRequest({ model, system, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }, { type: 'text', text: user }] }], tools: [{ name: 'Read', description: 'Read a file', input_schema: parameters }] }, undefined, 'parity-session'), 'parity-session')
    expect(wire.input).toContainEqual(expect.objectContaining({ role: 'developer', content: [{ type: 'input_text', text: system }] }))
    expect(wire.input).toContainEqual(expect.objectContaining({ role: 'user', content: expect.arrayContaining([{ type: 'input_text', text: user }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'auto' }]) }))
    expect(wire.input[0]).toMatchObject({ type: 'additional_tools', tools: [{ name: 'Read', parameters }] })
  })
})
