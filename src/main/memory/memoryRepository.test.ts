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

  it('discards settled proposals, refuses in-flight/applied ones and never touches the entry', async () => {
    const repository = await fixture()
    const settled = async (outcome: 'conflict' | 'rejected') => {
      const enqueued = await repository.enqueueMemoryProposal({ ...proposal, id: undefined })
      const claim = (await repository.claimMemoryProposal())!
      expect(claim.proposal.id).toBe(enqueued.id)
      await repository.settleMemoryProposal({ proposalId: enqueued.id, token: claim.token, outcome, reason: 'fixture' })
      return enqueued.id
    }
    const conflictId = await settled('conflict')
    const rejectedId = await settled('rejected')
    expect(await repository.deleteMemoryProposal(conflictId)).toBe(true)
    expect(await repository.deleteMemoryProposal(rejectedId)).toBe(true)
    expect(await repository.listMemoryProposals()).toEqual([])
    // Idempotent for the caller: an already discarded or unknown id is not an error.
    expect(await repository.deleteMemoryProposal(conflictId)).toBe(false)
    expect(await repository.deleteMemoryProposal('missing')).toBe(false)

    const pending = await repository.enqueueMemoryProposal({ ...proposal, id: undefined })
    await expect(repository.deleteMemoryProposal(pending.id)).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    const claim = (await repository.claimMemoryProposal())!
    await expect(repository.deleteMemoryProposal(pending.id)).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    const applied = await repository.settleMemoryProposal({ proposalId: pending.id, token: claim.token, outcome: 'applied', entry })
    await expect(repository.deleteMemoryProposal(applied.id)).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
    expect((await repository.listMemoryProposals()).map((row) => row.id)).toEqual([applied.id])
    expect(await repository.getMemoryEntryByPath(entry.relPath)).toMatchObject({ revision: 1, body: 'Body' })
  })

  it('discarding a settled proposal leaves the entry it references intact', async () => {
    const repository = await fixture()
    const stored = await repository.writeMemoryEntry(entry)
    const enqueued = await repository.enqueueMemoryProposal({ ...proposal, id: undefined, op: 'update', expectedRevision: 99 })
    const claim = (await repository.claimMemoryProposal())!
    await repository.settleMemoryProposal({ proposalId: enqueued.id, token: claim.token, outcome: 'conflict', reason: 'revisão errada' })
    expect(await repository.deleteMemoryProposal(enqueued.id)).toBe(true)
    expect(await repository.getMemoryEntryByPath(entry.relPath)).toMatchObject({ id: stored.id, revision: 1, body: 'Body' })
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
