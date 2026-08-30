import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { StorageError, type ConversationRecord } from './types'

const execFileAsync = promisify(execFile)
const MISSING_PROJECT_FOLDER_MESSAGE = 'A pasta selecionada não existe.'
const PROJECT_IDENTITY_FIELDS = ['projectId', 'projectSignature', 'projectRemoteGit'] as const

export interface ProjectIdentity {
  projectId: string
  signature: string
  remoteGit: string
}

export function normalizeGitRemote(value: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/\.git\/?$/i, '').replace(/\/$/, '')
  const scp = trimmed.match(/^git@([^:]+):(.+)$/i)
  if (scp) return `${scp[1].toLowerCase()}/${scp[2]}`
  try {
    const url = new URL(trimmed)
    return `${url.hostname.toLowerCase()}${url.pathname}`.replace(/\/$/, '')
  } catch {
    return trimmed.toLowerCase()
  }
}

function uuidFrom(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 5_000 })
  return result.stdout.trim()
}

export async function resolveProjectIdentity(cwd: string): Promise<ProjectIdentity> {
  const localPath = resolve(cwd)
  const info = await stat(localPath).catch(() => null)
  if (!info?.isDirectory()) throw new StorageError('INVALID_PERSISTED_DATA', MISSING_PROJECT_FOLDER_MESSAGE)
  let remoteGit = ''
  let rootCommit = ''
  try {
    remoteGit = normalizeGitRemote(await git(localPath, ['remote', 'get-url', 'origin']))
  } catch {
    // A local-only repository still gets a stable identity from its root commit.
  }
  try {
    rootCommit = await git(localPath, ['rev-list', '--max-parents=0', 'HEAD'])
    rootCommit = rootCommit.split(/\r?\n/, 1)[0]
  } catch {
    // Non-Git folders require an explicit mapping on every installation.
  }
  const material = remoteGit || rootCommit
    ? `git:${remoteGit}\nroot:${rootCommit}`
    : `manual-folder:${basename(localPath).toLocaleLowerCase('en-US')}`
  const signature = createHash('sha256').update(material).digest('hex')
  return { projectId: uuidFrom(`agent-code-project:${signature}`), signature, remoteGit }
}

export function isMissingProjectFolderError(cause: unknown): boolean {
  return cause instanceof StorageError &&
    cause.code === 'INVALID_PERSISTED_DATA' &&
    cause.message === MISSING_PROJECT_FOLDER_MESSAGE
}

/**
 * An existing legacy conversation can retain a device-local cwd whose folder
 * was moved or deleted. Updating its history is still safe when the renderer
 * sends that exact persisted cwd back; project identity remains immutable and
 * a new or changed invalid path is rejected.
 */
export function preserveProjectIdentityForMissingPersistedWrite(
  payload: ConversationRecord,
  persisted?: ConversationRecord
): ConversationRecord {
  if (typeof payload.cwd !== 'string' || !payload.cwd.trim()) return payload
  if (typeof persisted?.cwd !== 'string' ||
    persisted.cwd !== payload.cwd ||
    persisted.id !== payload.id) {
    throw new StorageError('INVALID_PERSISTED_DATA', MISSING_PROJECT_FOLDER_MESSAGE)
  }
  const result = { ...payload }
  for (const field of PROJECT_IDENTITY_FIELDS) {
    if (persisted[field] === undefined) delete result[field]
    else result[field] = persisted[field]
  }
  return result
}

export async function attachProjectIdentity(payload: ConversationRecord): Promise<ConversationRecord> {
  if (typeof payload.cwd !== 'string' || !payload.cwd.trim()) return payload
  const identity = await resolveProjectIdentity(payload.cwd)
  if (typeof payload.projectSignature === 'string' && payload.projectSignature !== identity.signature) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'A pasta selecionada não corresponde ao projeto desta conversa.')
  }
  if (typeof payload.projectId === 'string' && payload.projectId !== identity.projectId) {
    throw new StorageError('INVALID_PERSISTED_DATA', 'A identidade da pasta selecionada não corresponde ao projeto.')
  }
  return {
    ...payload,
    projectId: identity.projectId,
    projectSignature: identity.signature,
    ...(identity.remoteGit ? { projectRemoteGit: identity.remoteGit } : {})
  }
}

/**
 * Legacy conversations may reference a project folder that was moved or deleted.
 * That is missing device-local state, not corrupt shared history: migrate the
 * conversation without a project mapping and let the renderer request a folder.
 */
export async function attachProjectIdentityForMigration(payload: ConversationRecord): Promise<ConversationRecord> {
  if (typeof payload.cwd !== 'string' || !payload.cwd.trim()) return payload
  if (!(await stat(resolve(payload.cwd)).catch(() => null))?.isDirectory()) return payload
  return attachProjectIdentity(payload)
}
