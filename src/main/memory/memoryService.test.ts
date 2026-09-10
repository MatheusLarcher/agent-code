// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { MemoryService } from './memoryService'
import { MEMORY_PROPOSAL_MAX_ATTEMPTS } from './memoryModel'

const roots: string[] = []
const repositories: SqliteRepository[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(repositories.splice(0).map((repo) => repo.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-memory-test-'))
  roots.push(root)
  const directory = join(root, 'memories')
  await mkdir(directory)
  const repository = new SqliteRepository(root, join(root, 'fixture.db'), 'memory-test-device')
  repositories.push(repository)
  await repository.initialize()
  const logs: string[] = []
  const service = new MemoryService(repository, directory, { log: (line) => logs.push(line) })
  return { root, directory, repository, service, logs }
}

const create = { op: 'create' as const, relPath: 'project/lesson.md', title: 'Lesson', hook: 'Read before working', body: '# Lesson\nOriginal', proposedBy: 'fixture' }

async function seeded() {
  const context = await fixture()
  await context.service.propose(create)
  expect(await context.service.applyPending()).toEqual({ applied: 1, conflict: 0, rejected: 0, requeued: 0, uncertain: 0, projectionConflicts: [] })
  return context
}

describe('MemoryService (temporary fixtures only)', () => {
  it('commits create before projecting its content or index and applies revision CAS updates', async () => {
    const { service, repository, directory } = await fixture()
    const original = repository.settleMemoryProposal.bind(repository)
    vi.spyOn(repository, 'settleMemoryProposal').mockImplementation(async (input) => {
      if (input.outcome === 'applied') {
        await expect(readFile(join(directory, create.relPath), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).not.toContain(create.title)
      }
      return original(input)
    })
    await service.propose(create)
    await service.applyPending()
    vi.restoreAllMocks()
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ revision: 1, body: create.body })
    await service.propose({ ...create, op: 'update', body: 'Updated', expectedRevision: 1 })
    expect((await service.applyPending()).applied).toBe(1)
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ revision: 2, body: 'Updated' })
    expect(await readFile(join(directory, create.relPath), 'utf8')).toBe('Updated')
    await service.propose({ ...create, op: 'update', body: 'Stale', expectedRevision: 1 })
    expect((await service.applyPending()).conflict).toBe(1)
    expect(await readFile(join(directory, create.relPath), 'utf8')).toBe('Updated')
  })

  it('duplicate creates conflict even if their content is identical', async () => {
    const { service, repository } = await fixture()
    await service.propose(create)
    await service.propose({ ...create, title: 'Not interchangeable metadata' })
    const result = await service.applyPending()
    expect(result).toMatchObject({ applied: 1, conflict: 1 })
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ revision: 1 })
    expect((await service.listProposals()).map((proposal) => proposal.status).sort()).toEqual(['applied', 'conflict'])
  })

  it('retire commits a tombstone, archives content, excludes the index and never resurrects', async () => {
    const { service, repository, directory } = await seeded()
    await service.propose({ op: 'retire', relPath: create.relPath, expectedRevision: 1, proposedBy: 'fixture' })
    expect((await service.applyPending()).applied).toBe(1)
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ status: 'retired', revision: 2 })
    expect(await readFile(join(directory, '.retired', create.relPath), 'utf8')).toBe(create.body)
    await expect(readFile(join(directory, create.relPath))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).not.toContain('Lesson')
    // A delayed cloud sync puts the old projection back; it is removed, not imported.
    await writeFile(join(directory, create.relPath), create.body)
    await service.reconcile()
    await expect(readFile(join(directory, create.relPath))).rejects.toMatchObject({ code: 'ENOENT' })
    await service.propose(create)
    expect((await service.applyPending()).conflict).toBe(1)
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ status: 'retired', revision: 2 })
  })

  it('preserves divergent manually recreated retired paths and archive files as conflicts', async () => {
    const { service, repository, directory } = await seeded()
    await service.propose({ op: 'retire', relPath: create.relPath, proposedBy: 'fixture' })
    await service.applyPending()
    await writeFile(join(directory, create.relPath), 'Manual resurrection attempt')
    expect((await service.reconcile()).conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: create.relPath })]))
    expect(await readFile(join(directory, create.relPath), 'utf8')).toBe('Manual resurrection attempt')
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ status: 'retired', revision: 2 })
    await rm(join(directory, create.relPath))
    await writeFile(join(directory, '.retired', create.relPath), 'Manual archive edits')
    expect((await service.reconcile()).conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: `.retired/${create.relPath}` })]))
    expect(await readFile(join(directory, '.retired', create.relPath), 'utf8')).toBe('Manual archive edits')
  })

  it.each(['create', 'update', 'retire'] as const)('replays %s after crash immediately after database commit', async (op) => {
    const { service, repository, directory } = op === 'create' ? await fixture() : await seeded()
    await service.propose(op === 'create' ? create : { ...create, op, body: 'New committed body', expectedRevision: 1 })
    const original = repository.settleMemoryProposal.bind(repository)
    vi.spyOn(repository, 'settleMemoryProposal').mockImplementation(async (input) => {
      const result = await original(input)
      if (input.outcome === 'applied') {
        vi.spyOn(repository, 'listMemoryEntries').mockRejectedValue(new Error('Simulated process stop after commit'))
        throw new Error('Lost commit acknowledgment')
      }
      return result
    })
    await expect(service.applyPending()).rejects.toThrow('Simulated process stop')
    expect((await repository.listMemoryProposals()).at(-1)?.status).toBe('applied')
    if (op === 'create') await expect(readFile(join(directory, create.relPath))).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(join(directory, create.relPath), 'utf8')).toBe(create.body)
    vi.restoreAllMocks()
    const restarted = new MemoryService(repository, directory)
    expect((await restarted.reconcile()).conflicts).toEqual([])
    if (op === 'retire') {
      await expect(readFile(join(directory, create.relPath))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(directory, '.retired', create.relPath), 'utf8')).toBe(create.body)
    } else expect(await readFile(join(directory, create.relPath), 'utf8')).toBe(op === 'create' ? create.body : 'New committed body')
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ revision: op === 'create' ? 1 : 2 })
  })

  it('preserves and reports manual drift rather than importing or overwriting it', async () => {
    const { service, repository, directory } = await seeded()
    await writeFile(join(directory, create.relPath), 'User edited this manually')
    const result = await service.reconcile()
    expect(result.imported).toBe(0)
    expect(result.conflicts).toEqual([expect.objectContaining({ relPath: create.relPath })])
    await service.propose({ ...create, op: 'update', expectedRevision: 1, body: 'Authoritative next revision' })
    const applied = await service.applyPending()
    expect(applied).toMatchObject({ applied: 1, conflict: 0, uncertain: 0 })
    // Both pre/post reconcile see this conflict; the public result reports it once.
    expect(applied.projectionConflicts).toEqual([expect.objectContaining({ relPath: create.relPath, reason: expect.stringContaining('diverged') })])
    expect(await readFile(join(directory, create.relPath), 'utf8')).toBe('User edited this manually')
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ revision: 2, body: 'Authoritative next revision' })
    expect((await new MemoryService(repository, directory).reconcile()).conflicts).toHaveLength(1)
  })

  it('restores missing files, but fails conservatively when a journal is lost and local content is stale', async () => {
    const { service, repository, directory } = await seeded()
    await rm(join(directory, create.relPath))
    await service.reconcile()
    expect(await readFile(join(directory, create.relPath), 'utf8')).toBe(create.body)
    const entry = (await repository.getMemoryEntryByPath(create.relPath))!
    await repository.writeMemoryEntry({ ...entry, body: 'Database newer', expectedRevision: entry.revision })
    await rm(join(directory, '.memory-projection.json'))
    expect((await service.reconcile()).conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: create.relPath })]))
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ revision: 2, body: 'Database newer' })
    expect(await readFile(join(directory, create.relPath), 'utf8')).toBe(create.body)
  })

  it('imports unknown legacy files once, retaining curated metadata and the entire original index', async () => {
    const { service, repository, directory } = await fixture()
    const legacy = 'Legacy Notes.md'
    const index = `# Personal notes\n\n<!-- important metadata -->\n- [Curated title](${legacy}) — Curated hook\nUnparsed prose must survive.\n`
    // Parser deliberately supports spaces in old names as well as safe new slugs.
    await writeFile(join(directory, legacy), '# Body title\nBody hook')
    await writeFile(join(directory, 'MEMORY.md'), index)
    await writeFile(join(directory, 'attachment.txt'), 'Unknown attachment')
    expect((await service.reconcile()).imported).toBe(1)
    expect(await repository.getMemoryEntryByPath(legacy)).toMatchObject({ title: 'Curated title', hook: 'Curated hook', originAgent: 'import', revision: 1 })
    expect(await readFile(join(directory, '.memory-legacy-index.md'), 'utf8')).toBe(index)
    expect(await readFile(join(directory, legacy), 'utf8')).toBe('# Body title\nBody hook')
    expect(await readFile(join(directory, 'attachment.txt'), 'utf8')).toBe('Unknown attachment')
    expect((await service.reconcile()).imported).toBe(0)
    await writeFile(join(directory, 'MEMORY.md'), 'New manual index edits')
    expect((await service.reconcile()).conflicts).toEqual([expect.objectContaining({ relPath: 'MEMORY.md' })])
    expect(await readFile(join(directory, 'MEMORY.md'), 'utf8')).toBe('New manual index edits')
  })

  it('preserves project scope and legacy metadata on body-only update', async () => {
    const { service, repository } = await fixture()
    await service.propose({ ...create, scope: 'project', projectCwd: '/fixture/project' })
    await service.applyPending()
    await service.propose({ op: 'update', relPath: create.relPath, body: 'Changed only body', expectedRevision: 1, proposedBy: 'fixture' })
    await service.applyPending()
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ scope: 'project', projectCwd: '/fixture/project', title: create.title, hook: create.hook })
  })

  it('bounds retries across passes and settles terminal failure at the attempt limit', async () => {
    const { service, repository } = await fixture()
    await service.propose(create)
    const original = repository.settleMemoryProposal.bind(repository)
    vi.spyOn(repository, 'settleMemoryProposal').mockImplementation(async (input) => {
      if (input.outcome === 'applied') throw new Error('Database write unavailable')
      return original(input)
    })
    for (let i = 1; i < MEMORY_PROPOSAL_MAX_ATTEMPTS; i++) {
      expect((await service.applyPending()).requeued).toBe(1)
      expect((await repository.listMemoryProposals())[0]).toMatchObject({ status: 'pending', attempts: i })
    }
    expect((await service.applyPending()).conflict).toBe(1)
    expect((await repository.listMemoryProposals())[0]).toMatchObject({ status: 'conflict', attempts: MEMORY_PROPOSAL_MAX_ATTEMPTS })
    expect(await repository.getMemoryEntryByPath(create.relPath)).toBeNull()
  })

  it('stops a drain if both application and settlement fail, without a busy loop', async () => {
    const { service, repository } = await fixture()
    await service.propose(create)
    const claim = vi.spyOn(repository, 'claimMemoryProposal')
    vi.spyOn(repository, 'settleMemoryProposal').mockRejectedValue(new Error('Store unavailable'))
    expect(await service.applyPending()).toMatchObject({ uncertain: 1, requeued: 0, applied: 0 })
    expect(claim).toHaveBeenCalledTimes(1)
    expect((await repository.listMemoryProposals())[0]).toMatchObject({ status: 'pending', attempts: 1 })
    expect(await repository.getMemoryEntryByPath(create.relPath)).toBeNull()
  })

  it('reports uncertain rather than requeued when commit acknowledgment is lost', async () => {
    const { service, repository, directory } = await fixture()
    await service.propose(create)
    const original = repository.settleMemoryProposal.bind(repository)
    vi.spyOn(repository, 'settleMemoryProposal').mockImplementation(async (input) => {
      const result = await original(input)
      if (input.outcome === 'applied') throw new Error('Lost commit acknowledgment')
      return result
    })
    const claim = vi.spyOn(repository, 'claimMemoryProposal')
    expect(await service.applyPending()).toMatchObject({ uncertain: 1, requeued: 0, applied: 0, projectionConflicts: [] })
    expect(claim).toHaveBeenCalledTimes(1)
    expect((await repository.listMemoryProposals())[0]).toMatchObject({ status: 'applied', attempts: 1 })
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ revision: 1, body: create.body })
    expect(await readFile(join(directory, create.relPath), 'utf8')).toBe(create.body)
  })

  it('serializes simultaneous service instances on one local root', async () => {
    const { service, repository, directory } = await seeded()
    const other = new MemoryService(repository, join(directory, '.'))
    await service.propose({ ...create, op: 'update', expectedRevision: 1, body: 'Candidate A' })
    await other.propose({ ...create, op: 'update', expectedRevision: 1, body: 'Candidate B' })
    const results = await Promise.all([service.applyPending(), other.applyPending(), service.reconcile(), other.reconcile()])
    expect(results.slice(0, 2).reduce((total, summary) => total + ('applied' in summary ? summary.applied : 0), 0)).toBe(1)
    const entry = (await repository.getMemoryEntryByPath(create.relPath))!
    expect(entry.revision).toBe(2)
    expect(await readFile(join(directory, create.relPath), 'utf8')).toBe(entry.body)
    expect((await service.reconcile()).conflicts).toEqual([])
  })

  it('replays an interrupted projection journal around the file rename', async () => {
    const { service, repository, directory } = await seeded()
    const entry = (await repository.getMemoryEntryByPath(create.relPath))!
    await repository.writeMemoryEntry({ ...entry, body: 'Latest database value', expectedRevision: 1 })
    const internal = service as unknown as { writeAtomic(path: string, content: string): Promise<void> }
    const original = internal.writeAtomic.bind(service)
    let failed = false
    vi.spyOn(internal, 'writeAtomic').mockImplementation(async (path, content) => {
      await original(path, content)
      if (path === join(directory, create.relPath) && !failed) { failed = true; throw new Error('Crash after rename') }
    })
    expect((await service.reconcile()).conflicts).toHaveLength(1)
    vi.restoreAllMocks()
    expect((await new MemoryService(repository, directory).reconcile()).conflicts).toHaveLength(0)
    expect(await repository.getMemoryEntryByPath(create.relPath)).toMatchObject({ revision: 2, body: 'Latest database value' })
  })

  it('refuses a corrupt journal without overwriting files', async () => {
    const { service, directory } = await seeded()
    await writeFile(join(directory, '.memory-projection.json'), '{broken')
    await expect(service.reconcile()).rejects.toThrow()
    expect(await readFile(join(directory, create.relPath), 'utf8')).toBe(create.body)
  })

  it('rejects linked roots and linked subdirectories and never imports through them', async () => {
    const { service, repository, directory, root } = await fixture()
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'private.md'), 'Never touch')
    await symlink(outside, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.propose({ ...create, relPath: 'linked/private.md' })).rejects.toThrow('Unsafe memory path')
    const result = await service.reconcile()
    expect(result.conflicts).toEqual([expect.objectContaining({ relPath: 'linked' })])
    expect(await repository.listMemoryEntries()).toEqual([])
    expect(await readFile(join(outside, 'private.md'), 'utf8')).toBe('Never touch')
    await symlink(outside, join(root, 'linked-root'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(new MemoryService(repository, join(root, 'linked-root')).reconcile()).rejects.toThrow('Unsafe memory path')
  })
})
