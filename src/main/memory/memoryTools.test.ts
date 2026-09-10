// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { StorageError, type MemoryEntry, type MemoryProposal } from '../persistence/types'
import { buildMemoryTools, type MemoryToolDeps } from './memoryTools'
import type { SanitizedProposal } from './memorySecrets'

/** Nenhum banco, disco ou pasta de memórias: só dublês em memória. */

type Tool = ReturnType<typeof buildMemoryTools>[number]
type Result = { content: { type: string; text?: string }[] }

function callText(tool: Tool, args: unknown): Promise<string> {
  return (tool.handler(args as never, undefined) as Promise<Result>).then((result) =>
    result.content.map((part) => part.text ?? '').join('\n')
  )
}

function find(tools: Tool[], name: string): Tool {
  const found = tools.find((tool) => tool.name === name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'e1',
    relPath: 'projeto/build.md',
    title: 'Build',
    hook: 'Como buildar',
    scope: 'user',
    projectCwd: null,
    domain: null,
    body: 'corpo',
    bodyHash: 'h',
    revision: 3,
    status: 'active',
    originConversationId: null,
    originMessageId: null,
    originAgent: null,
    supersedesId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: 'p1',
    entryId: null,
    op: 'create',
    relPath: 'projeto/build.md',
    title: 'Build',
    hook: 'Como buildar',
    body: 'corpo',
    scope: 'user',
    projectCwd: null,
    domain: null,
    originConversationId: 'c1',
    originMessageId: null,
    originAgent: 'agente',
    status: 'applied',
    reason: null,
    proposedBy: 'session:c1',
    expectedRevision: null,
    attempts: 1,
    leaseToken: null,
    leaseExpiresAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

const emptySummary = { applied: 0, conflict: 0, rejected: 0, requeued: 0, uncertain: 0, projectionConflicts: [] }

function sanitizeStub(extra: Partial<SanitizedProposal> = {}) {
  return vi.fn(async (input: Parameters<NonNullable<MemoryToolDeps['sanitize']>>[0]) => ({
    input,
    stored: [],
    skipped: [],
    notes: [],
    ...extra
  })) as unknown as NonNullable<MemoryToolDeps['sanitize']>
}

function makeDeps(overrides: Partial<MemoryToolDeps> = {}): MemoryToolDeps {
  const service = {
    memoriesDir: 'C:/fake/memories',
    propose: vi.fn(async () => proposal()),
    listEntries: vi.fn(async () => [] as MemoryEntry[]),
    listProposals: vi.fn(async () => [] as MemoryProposal[]),
    applyPending: vi.fn(async () => ({ ...emptySummary, applied: 1 }))
  } as unknown as MemoryToolDeps['service']
  return {
    service,
    vault: null,
    sanitize: sanitizeStub(),
    secretVaultEnabled: () => false,
    readSecret: null,
    conversationId: 'c1',
    agent: 'agente',
    ...overrides
  }
}

describe('memory_propose', () => {
  it('reports the create as applied and passes origin metadata', async () => {
    const deps = makeDeps()
    const tools = buildMemoryTools(deps)
    const out = await callText(find(tools, 'memory_propose'), {
      op: 'create',
      rel_path: 'projeto/build.md',
      title: 'Build',
      hook: 'Como buildar',
      body: 'corpo'
    })
    expect(out).toContain('aplicada')
    expect(out).toContain('projeto/build.md')
    expect(deps.service.propose).toHaveBeenCalledWith(
      expect.objectContaining({ proposedBy: 'session:c1', originConversationId: 'c1', originAgent: 'agente' })
    )
    expect(deps.service.applyPending).toHaveBeenCalledTimes(1)
  })

  it('reports a conflict with the current revision so the model can retry', async () => {
    const deps = makeDeps()
    deps.service.propose = vi.fn(async () => proposal({ op: 'update', status: 'pending', expectedRevision: 2 }))
    deps.service.applyPending = vi.fn(async () => ({ ...emptySummary, conflict: 1 }))
    deps.service.listProposals = vi.fn(async () => [
      proposal({ op: 'update', status: 'conflict', reason: 'projeto/build.md está na revisão 3, não 2.' })
    ])
    deps.service.listEntries = vi.fn(async () => [entry({ revision: 3 })])
    const out = await callText(find(buildMemoryTools(deps), 'memory_propose'), {
      op: 'update',
      rel_path: 'projeto/build.md',
      body: 'novo',
      expected_revision: 2
    })
    expect(out).toContain('Conflito')
    expect(out).toContain('não 2')
    expect(out).toContain('expected_revision = 3')
  })

  it('surfaces the sanitize notes without echoing any secret value', async () => {
    const deps = makeDeps({
      sanitize: sanitizeStub({
        stored: ['projeto.build.1'],
        skipped: [{ value: 'sk-super-secreto-123456', kind: 'openai-key' }],
        notes: ['1 valor sensível movido para o cofre.']
      })
    })
    const out = await callText(find(buildMemoryTools(deps), 'memory_propose'), {
      op: 'create',
      rel_path: 'projeto/build.md',
      title: 'Build',
      hook: 'h',
      body: 'token=sk-super-secreto-123456'
    })
    expect(out).toContain('projeto.build.1')
    expect(out).toContain('openai-key')
    expect(out).toContain('1 valor sensível movido para o cofre.')
    expect(out).not.toContain('sk-super-secreto-123456')
  })

  it('turns an invalid path into a readable message instead of throwing', async () => {
    const deps = makeDeps()
    deps.service.propose = vi.fn(async () => {
      throw new StorageError('INVALID_PERSISTED_DATA', 'rel_path deve terminar em .md: ../fora')
    })
    const out = await callText(find(buildMemoryTools(deps), 'memory_propose'), { op: 'create', rel_path: '../fora' })
    expect(out).toContain('memory_propose falhou')
    expect(out).toContain('rel_path deve terminar em .md')
    expect(out).not.toContain('at ')
  })
})

describe('memory_list', () => {
  it('shows the current revision and says when the output is truncated', async () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry({ id: `e${i}`, relPath: `n${i}.md`, revision: i + 1 }))
    const deps = makeDeps()
    deps.service.listEntries = vi.fn(async () => entries)
    const out = await callText(find(buildMemoryTools(deps), 'memory_list'), { limit: 2 })
    expect(out).toContain('revisão 1')
    expect(out).toContain('revisão 2')
    expect(out).not.toContain('revisão 3')
    expect(out).toContain('3 de 5 memórias omitidas')
  })
})

describe('memory_status', () => {
  it('lists pending and conflicting proposals with the reason', async () => {
    const deps = makeDeps()
    deps.service.listProposals = vi.fn(async () => [proposal({ status: 'conflict', reason: 'revisão mudou' })])
    const out = await callText(find(buildMemoryTools(deps), 'memory_status'), {})
    expect(out).toContain('[conflict]')
    expect(out).toContain('revisão mudou')
  })
})

describe('memory_secret_get', () => {
  it('is not registered when the vault switch is off at creation', () => {
    const tools = buildMemoryTools(makeDeps({ secretVaultEnabled: () => false }))
    expect(tools.map((tool) => tool.name)).not.toContain('memory_secret_get')
  })

  it('returns the plaintext while enabled and refuses once the switch flips off', async () => {
    let enabled = true
    const deps = makeDeps({
      secretVaultEnabled: () => enabled,
      readSecret: vi.fn(async () => 'valor-real')
    })
    const tool = find(buildMemoryTools(deps), 'memory_secret_get')
    expect(await callText(tool, { name: 'projeto.build.1' })).toBe('valor-real')
    enabled = false
    const out = await callText(tool, { name: 'projeto.build.1' })
    expect(out).toContain('desligado')
    expect(out).not.toContain('valor-real')
  })

  it('refuses without throwing when readSecret is unavailable', async () => {
    const deps = makeDeps({ secretVaultEnabled: () => true, readSecret: null })
    const out = await callText(find(buildMemoryTools(deps), 'memory_secret_get'), { name: 'x' })
    expect(out).toContain('não está disponível')
  })
})
