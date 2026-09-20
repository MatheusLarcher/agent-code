// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { SqliteRepository } from './sqliteRepository'

const dirs: string[] = []
const message = (text: string) => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
  uuid: `sdk-${text}`
}) as SDKUserMessage

async function repository(): Promise<SqliteRepository> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-queue-'))
  dirs.push(dir)
  const repo = new SqliteRepository(dir, join(dir, 'agent-code.db'), 'queue-test')
  await repo.initialize()
  return repo
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('AgentInputQueueRepository (SQLite)', () => {
  it('preserves FIFO order and blocks later inputs while the head is processing', async () => {
    const repo = await repository()
    const first = await repo.enqueueAgentInput('conv', message('first'), '00000000-0000-4000-8000-000000000001')
    const second = await repo.enqueueAgentInput('conv', message('second'), '00000000-0000-4000-8000-000000000002')

    expect((await repo.claimNextAgentInput('conv'))?.id).toBe(first.id)
    expect(await repo.claimNextAgentInput('conv')).toBeNull()
    await repo.completeAgentInput(first.id)
    expect((await repo.claimNextAgentInput('conv'))?.id).toBe(second.id)
    await repo.close()
  })

  it('returns the existing row for duplicate message UUIDs without adding a sequence', async () => {
    const repo = await repository()
    const first = await repo.enqueueAgentInput('conv', message('same'), '00000000-0000-4000-8000-000000000003')
    const duplicate = await repo.enqueueAgentInput('conv', message('changed'), '00000000-0000-4000-8000-000000000003')

    expect(duplicate).toMatchObject({ id: first.id, sequence: first.sequence, message: message('same') })
    expect((await repo.listAgentInputs('conv'))).toHaveLength(1)
    await repo.close()
  })

  it('recovers processing rows and increments attempts on the next claim', async () => {
    const repo = await repository()
    const item = await repo.enqueueAgentInput('conv', message('00000000-0000-4000-8000-000000000004'), '00000000-0000-4000-8000-000000000004')
    const claimed = await repo.claimNextAgentInput('conv')
    expect(claimed?.attemptCount).toBe(1)
    expect(await repo.recoverAgentInput('conv')).toBe(1)
    expect((await repo.listAgentInputs('conv'))[0]).toMatchObject({ status: 'pending', processingStartedAt: null })
    expect((await repo.claimNextAgentInput('conv'))).toMatchObject({ id: item.id, status: 'processing', attemptCount: 2 })
    await repo.close()
  })

  it('requeues errors and removes only successfully completed processing rows', async () => {
    const repo = await repository()
    const item = await repo.enqueueAgentInput('conv', message('00000000-0000-4000-8000-000000000005'), '00000000-0000-4000-8000-000000000005')
    await repo.claimNextAgentInput('conv')
    await repo.requeueAgentInput(item.id, 'network failure')
    expect((await repo.listAgentInputs('conv'))[0]).toMatchObject({ status: 'pending', lastError: 'network failure' })
    const claimed = await repo.claimNextAgentInput('conv')
    expect(claimed?.id).toBe(item.id)
    await repo.completeAgentInput(item.id)
    expect(await repo.listAgentInputs('conv')).toEqual([])
    await repo.close()
  })
})
