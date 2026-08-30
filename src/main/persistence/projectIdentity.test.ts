import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  attachProjectIdentity,
  attachProjectIdentityForMigration,
  normalizeGitRemote,
  preserveProjectIdentityForMissingPersistedWrite,
  resolveProjectIdentity
} from './projectIdentity'

describe('project identity', () => {
  const missingPath = (): string => join(tmpdir(), `agent-code-missing-${randomUUID()}`)

  it('normalizes equivalent HTTPS and SSH GitHub remotes', () => {
    expect(normalizeGitRemote('https://github.com/Org/Repo.git')).toBe('github.com/Org/Repo')
    expect(normalizeGitRemote('git@github.com:Org/Repo.git')).toBe('github.com/Org/Repo')
  })

  it('derives a stable identity and refuses a mismatched manual mapping', async () => {
    const first = await resolveProjectIdentity(process.cwd())
    const second = await resolveProjectIdentity(process.cwd())
    expect(second).toEqual(first)
    expect(first.projectId).toMatch(/^[0-9a-f-]{36}$/)
    const payload = await attachProjectIdentity({ id: 'conversation', cwd: process.cwd() })
    expect(payload).toMatchObject({ projectId: first.projectId, projectSignature: first.signature })
    await expect(attachProjectIdentity({
      ...payload,
      projectSignature: 'not-the-same-project'
    })).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
  })

  it('keeps legacy history when its device-local folder no longer exists', async () => {
    const payload = { id: 'legacy', title: 'Moved project', cwd: missingPath() }
    await expect(attachProjectIdentityForMigration(payload)).resolves.toEqual(payload)
    await expect(attachProjectIdentity(payload)).rejects.toMatchObject({ code: 'INVALID_PERSISTED_DATA' })
  })

  it('updates an existing legacy history with the same missing cwd but rejects new or changed invalid paths', async () => {
    const persistedCwd = missingPath()
    const persisted = {
      id: 'legacy',
      title: 'Before',
      cwd: persistedCwd,
      projectId: 'trusted-project',
      projectSignature: 'trusted-signature'
    }
    expect(preserveProjectIdentityForMissingPersistedWrite({
      ...persisted,
      title: 'After',
      projectId: 'untrusted-change',
      projectSignature: 'untrusted-change'
    }, persisted)).toMatchObject({
      title: 'After',
      projectId: 'trusted-project',
      projectSignature: 'trusted-signature'
    })
    expect(() => preserveProjectIdentityForMissingPersistedWrite({
      id: 'legacy',
      cwd: missingPath()
    }, persisted)).toThrowError(expect.objectContaining({ code: 'INVALID_PERSISTED_DATA' }))
    expect(() => preserveProjectIdentityForMissingPersistedWrite({
      id: 'new',
      cwd: persisted.cwd
    })).toThrowError(expect.objectContaining({ code: 'INVALID_PERSISTED_DATA' }))
  })
})
