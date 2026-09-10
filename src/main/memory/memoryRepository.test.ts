// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from '../persistence/sqliteRepository'
import type { MemoryEntryWrite } from '../persistence/types'
import { normalizeMemoryProposal } from './memoryModel'

const roots: string[] = []
const repositories: SqliteRepository[] = []
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-memory-repository-test-'))
  roots.push(root)
  const repository = new SqliteRepository(root, join(root, 'fixture.db'), 'fixture-device')
  repositories.push(repository)
  await repository.initialize()
  return repository
}
const entry: MemoryEntryWrite = { relPath: 'note.md', title: 'Note', hook: 'Hook', body: 'Body', scope: 'user', status: 'active', expectedRevision: 0 }
const proposal = normalizeMemoryProposal('.', { ...entry, op: 'create', expectedRevision: null, proposedBy: 'fixture' })

describe('SQLite memory transaction contract (isolated fixture)', () => {
  it('atomically commits matching entry creation and settlement', async () => {
    const repository = await fixture()
    await repository.enqueueMemoryProposal(proposal)
    const claim = (await repository.claimMemoryProposal())!
    const settled = await repository.settleMemoryProposal({ proposalId: claim.proposal.id, token: claim.token, outcome: 'applied', entry })
    const stored = (await repository.getMemoryEntryByPath(entry.relPath))!
    expect(settled).toMatchObject({ status: 'applied', entryId: stored.id, leaseToken: null })
    expect(stored).toMatchObject({ revision: 1, body: entry.body })
  })

  it('rolls entry mutation back if proposal settlement fails after the entry write', async () => {
    const repository = await fixture()
    await repository.enqueueMemoryProposal(proposal)
    const claim = (await repository.claimMemoryProposal())!
    repository.write((db) => db.exec(`CREATE TRIGGER fixture_fail_settlement BEFORE UPDATE OF status ON memory_proposals WHEN NEW.status = 'applied' BEGIN SELECT RAISE(ABORT, 'fixture failed settlement'); END;`))
    await expect(repository.settleMemoryProposal({ proposalId: claim.proposal.id, token: claim.token, outcome: 'applied', entry })).rejects.toThrow('fixture failed settlement')
    expect(await repository.getMemoryEntryByPath(entry.relPath)).toBeNull()
    expect((await repository.listMemoryProposals())[0]).toMatchObject({ status: 'pending', leaseToken: claim.token })
  })

  it('CAS failure leaves the proposal pending and the authoritative entry untouched', async () => {
    const repository = await fixture()
    await repository.writeMemoryEntry(entry)
    await repository.enqueueMemoryProposal(proposal)
    const claim = (await repository.claimMemoryProposal())!
    await expect(repository.settleMemoryProposal({ proposalId: claim.proposal.id, token: claim.token, outcome: 'applied', entry: { ...entry, body: 'Loser' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect((await repository.listMemoryProposals())[0]).toMatchObject({ status: 'pending' })
    expect(await repository.getMemoryEntryByPath(entry.relPath)).toMatchObject({ body: 'Body', revision: 1 })
  })

  it('rejects a mismatching path/op/revision instead of marking an unrelated entry applied', async () => {
    const repository = await fixture()
    await repository.enqueueMemoryProposal(proposal)
    const claim = (await repository.claimMemoryProposal())!
    const settle = (write: MemoryEntryWrite) => repository.settleMemoryProposal({ proposalId: claim.proposal.id, token: claim.token, outcome: 'applied', entry: write })
    await expect(settle({ ...entry, relPath: 'unrelated.md' })).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    await expect(settle({ ...entry, status: 'retired' })).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    await expect(settle({ ...entry, expectedRevision: 1 })).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    expect(await repository.listMemoryEntries()).toEqual([])
    expect((await repository.listMemoryProposals())[0]).toMatchObject({ status: 'pending' })
  })

  it('only the current live lease can settle, and a lost acknowledgment cannot apply twice', async () => {
    const repository = await fixture()
    await repository.enqueueMemoryProposal(proposal)
    const first = (await repository.claimMemoryProposal())!
    expect(await repository.claimMemoryProposal()).toBeNull()
    await expect(repository.settleMemoryProposal({ proposalId: first.proposal.id, token: 'wrong', outcome: 'applied', entry })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    repository.write((db) => db.prepare('UPDATE memory_proposals SET lease_expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', first.proposal.id))
    const next = (await repository.claimMemoryProposal())!
    expect(next.proposal.attempts).toBe(2)
    expect(next.token).not.toBe(first.token)
    await expect(repository.settleMemoryProposal({ proposalId: first.proposal.id, token: first.token, outcome: 'applied', entry })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await repository.settleMemoryProposal({ proposalId: next.proposal.id, token: next.token, outcome: 'applied', entry })
    await expect(repository.settleMemoryProposal({ proposalId: next.proposal.id, token: next.token, outcome: 'applied', entry })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    expect(await repository.getMemoryEntryByPath(entry.relPath)).toMatchObject({ revision: 1 })
  })

  it('rejects stale direct updates and preserves retirement revision metadata', async () => {
    const repository = await fixture()
    const created = await repository.writeMemoryEntry(entry)
    const updated = await repository.writeMemoryEntry({ ...created, body: 'Changed', expectedRevision: 1 })
    await expect(repository.writeMemoryEntry({ ...updated, body: 'Stale', expectedRevision: 1 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const retired = await repository.writeMemoryEntry({ ...updated, status: 'retired', expectedRevision: 2 })
    expect(retired).toMatchObject({ id: created.id, revision: 3, status: 'retired', body: 'Changed', createdAt: created.createdAt })
  })
})
