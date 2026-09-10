// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteRepository } from './sqliteRepository'
import { TaskLedger } from '../tasks/taskLedger'
import { normalizeMemoryProposal } from '../memory/memoryModel'
import { hashText } from './hashes'
import type { MemoryEntryWrite } from './types'

const roots: string[] = []
const repositories: SqliteRepository[] = []
afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-record-text-'))
  roots.push(root)
  const repository = new SqliteRepository(root, join(root, 'fixture.db'), 'test-device')
  repositories.push(repository)
  await repository.initialize()
  return repository
}

const samples = ['before\0after', 'literal \uE000agent-code-pg-escape:0 and \uE000agent-code-pg-escape:e']

describe.each(samples)('SQLite ordinary APIs preserve %j', (text) => {
  it('preserves task, step, event and deliverable text through write and read APIs', async () => {
    const repository = await fixture()
    const ledger = new TaskLedger(repository)
    const task = await ledger.createTask({ projectCwd: 'C:/fixture', title: text, goal: text, acceptance: [text] })
    expect(task).toMatchObject({ title: text, goal: text, acceptance: [text] })
    expect(await ledger.getTask(task.id)).toEqual(task)
    expect(await ledger.listTasks()).toEqual([task])
    const claim = (await ledger.claimTask('test-agent'))!
    const fence = { token: claim.token, fencingEpoch: claim.fencingEpoch }
    expect(claim.task.title).toBe(text)
    expect((await ledger.renewTaskLease(task.id, fence)).task.goal).toBe(text)
    expect((await ledger.transitionTask(task.id, 'pending', 'running', fence)).title).toBe(text)
    const step = await ledger.appendStep({ taskId: task.id, kind: 'verify', agent: text, fence })
    expect(step.agent).toBe(text)
    expect((await ledger.listSteps(task.id))[0].agent).toBe(text)
    const deliverable = await ledger.addDeliverable({ taskId: task.id, stepId: step.id, kind: 'note', summary: text, fence })
    expect(deliverable.summary).toBe(text)
    expect(await ledger.listDeliverables(task.id)).toEqual([deliverable])
    const event = await ledger.appendEvent({ taskId: task.id, stepId: step.id, kind: 'note', data: { text } })
    expect((await ledger.listEvents(task.id)).find((item) => item.id === event.id)?.data).toEqual({ text })
  })

  it('preserves memory bodies, metadata and hashes on direct write/get/list', async () => {
    const repository = await fixture()
    const input: MemoryEntryWrite = { relPath: 'note.md', title: text, hook: text, body: text, scope: 'user', status: 'active', expectedRevision: 0 }
    const created = await repository.writeMemoryEntry(input)
    expect(created).toMatchObject({ title: text, hook: text, body: text, bodyHash: hashText(text) })
    expect(await repository.getMemoryEntryByPath('note.md')).toEqual(created)
    expect(await repository.listMemoryEntries()).toEqual([created])
  })

  it('preserves proposal bodies through enqueue/claim/application and rejection reasons', async () => {
    const repository = await fixture()
    const entry: MemoryEntryWrite = { relPath: 'proposal.md', title: text, hook: text, body: text, scope: 'user', status: 'active', expectedRevision: 0 }
    const proposal = await repository.enqueueMemoryProposal(normalizeMemoryProposal('.', {
      ...entry, op: 'create', expectedRevision: null, proposedBy: 'fixture'
    }))
    expect(proposal).toMatchObject({ body: text, title: text, hook: text })
    const claim = (await repository.claimMemoryProposal())!
    expect(claim.proposal.body).toBe(text)
    const applied = await repository.settleMemoryProposal({ proposalId: proposal.id, token: claim.token, outcome: 'applied', entry })
    expect(applied).toMatchObject({ status: 'applied', body: text })
    expect((await repository.listMemoryProposals())[0].body).toBe(text)
    expect(await repository.getMemoryEntryByPath(entry.relPath)).toMatchObject({ body: text, bodyHash: hashText(text) })
    const rejectedProposal = await repository.enqueueMemoryProposal(normalizeMemoryProposal('.', {
      op: 'create', relPath: 'rejected.md', title: 'Rejected', hook: 'Hook', body: text, proposedBy: 'fixture'
    }))
    const second = (await repository.claimMemoryProposal())!
    const rejected = await repository.settleMemoryProposal({ proposalId: rejectedProposal.id, token: second.token, outcome: 'rejected', reason: text })
    expect(rejected.reason).toBe(text)
    expect((await repository.listMemoryProposals({ status: 'rejected' }))[0].reason).toBe(text)
  })
})
