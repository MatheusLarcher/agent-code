import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  attachProjectIdentity,
  attachProjectIdentityForMigration,
  isProjectIdentityMismatchError,
  normalizeGitRemote,
  preserveProjectIdentityForMissingPersistedWrite,
  resolveProjectIdentity,
  sameProjectFolder,
  withoutProjectIdentity
} from './projectIdentity'
import { StorageError } from './types'

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

  it('recognizes only the identity mismatch errors', async () => {
    const identity = async () => ({ projectId: 'novo', signature: 'nova', remoteGit: '' })
    const bySignature = await attachProjectIdentity({ id: 'c', cwd: 'x', projectSignature: 'antiga' }, identity).catch((e: unknown) => e)
    const byId = await attachProjectIdentity({ id: 'c', cwd: 'x', projectId: 'antigo' }, identity).catch((e: unknown) => e)
    expect(isProjectIdentityMismatchError(bySignature)).toBe(true)
    expect(isProjectIdentityMismatchError(byId)).toBe(true)
    expect(isProjectIdentityMismatchError(new StorageError('INVALID_PERSISTED_DATA', 'A pasta selecionada não existe.'))).toBe(false)
    expect(isProjectIdentityMismatchError(new Error('A pasta selecionada não corresponde ao projeto desta conversa.'))).toBe(false)
  })

  it('compares project folders after resolve, case-insensitive only on Windows', () => {
    const folder = join(tmpdir(), 'Projeto')
    expect(sameProjectFolder(folder, join(folder, '.'), 'linux')).toBe(true)
    expect(sameProjectFolder(folder, folder.toUpperCase(), 'win32')).toBe(true)
    expect(sameProjectFolder(folder, folder.replace('Projeto', 'projeto'), 'linux')).toBe(false)
    expect(sameProjectFolder(folder, join(tmpdir(), 'Outro'), 'win32')).toBe(false)
  })

  it('strips only the project identity fields', () => {
    expect(withoutProjectIdentity({
      id: 'c', cwd: 'x', projectId: 'p', projectSignature: 's', projectRemoteGit: 'r'
    })).toEqual({ id: 'c', cwd: 'x' })
  })
})
