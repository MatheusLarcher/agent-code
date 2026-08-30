import {
  foldSessionSummary,
  forkSession,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  type SessionSummaryEntry
} from '@anthropic-ai/claude-agent-sdk'
import type { PoolClient } from 'pg'
import { hashJson, normalizeJson, type JsonValue } from './hashes'
import { StorageError, type PersistenceRepository, type VersionedConversation } from './types'
import { decodePostgresJson, encodePostgresJson } from './postgresEncoding'

export interface ImportedSessionItem {
  entity: 'sdk-session' | 'conversation'
  id: string
  contentHash: string
}

export interface SessionBundle {
  conversationId: string
  sessionId: string
  mtime: number
  conversationPayload: Record<string, unknown>
  paths: Array<{ subpath?: string; entries: SessionStoreEntry[] }>
}

export async function readSessions(
  source: PersistenceRepository,
  conversations: VersionedConversation[]
): Promise<SessionBundle[]> {
  const bundles: SessionBundle[] = []
  for (const conversation of conversations) {
    const store = source.createSessionStore(conversation.id)
    const sessions = (await store.listSessions?.(conversation.id)) ?? []
    for (const session of sessions) {
      const mainKey = { projectKey: conversation.id, sessionId: session.sessionId }
      const paths: SessionBundle['paths'] = []
      const main = await store.load(mainKey)
      if (main?.length) paths.push({ entries: main })
      for (const subpath of (await store.listSubkeys?.(mainKey)) ?? []) {
        const entries = await store.load({ ...mainKey, subpath })
        if (entries?.length) paths.push({ subpath, entries })
      }
      if (paths.length) {
        bundles.push({
          conversationId: conversation.id,
          sessionId: session.sessionId,
          mtime: session.mtime,
          conversationPayload: conversation.payload,
          paths
        })
      }
    }
  }
  return bundles
}

function isPrefix(left: unknown[], right: unknown[]): boolean {
  if (left.length > right.length) return false
  return left.every((entry, index) => JSON.stringify(entry) === JSON.stringify(right[index]))
}

export async function importSessions(
  client: PoolClient,
  bundles: SessionBundle[],
  installationId: string
): Promise<ImportedSessionItem[]> {
  const imported: ImportedSessionItem[] = []
  for (const bundle of bundles) {
    await client.query(
      `INSERT INTO sdk_sessions(conversation_id, session_id, mtime_ms, sdk_version, verified_hash, resume_ready)
       VALUES($1, $2, $3, '0.3.220', NULL, false)
       ON CONFLICT(conversation_id, session_id) DO NOTHING`,
      [bundle.conversationId, bundle.sessionId, bundle.mtime]
    )
    const existing = await client.query<{ subpath: string; entry: SessionStoreEntry }>(
      `SELECT subpath, entry FROM sdk_session_entries
       WHERE conversation_id = $1 AND session_id = $2 ORDER BY subpath, sequence FOR UPDATE`,
      [bundle.conversationId, bundle.sessionId]
    )
    const targetPaths: SessionBundle['paths'] = []
    for (const row of existing.rows) {
      let path = targetPaths.find((entry) => (entry.subpath ?? '') === row.subpath)
      if (!path) {
        path = row.subpath ? { subpath: row.subpath, entries: [] } : { entries: [] }
        targetPaths.push(path)
      }
      path.entries.push(decodePostgresJson(normalizeJson(row.entry)) as SessionStoreEntry)
    }
    const subpaths = [...new Set([
      ...bundle.paths.map((path) => path.subpath ?? ''),
      ...targetPaths.map((path) => path.subpath ?? '')
    ])].sort()
    const divergent = subpaths.some((subpath) => {
      const sourceEntries = bundle.paths.find((path) => (path.subpath ?? '') === subpath)?.entries ?? []
      const targetEntries = targetPaths.find((path) => (path.subpath ?? '') === subpath)?.entries ?? []
      return !isPrefix(sourceEntries, targetEntries) && !isPrefix(targetEntries, sourceEntries)
    })
    if (divergent) {
      // Decide before appending any prefix path. Otherwise a divergence found
      // in a later subagent transcript would partially mutate the target
      // session before the source is preserved as a public SDK fork.
      imported.push(...await forkDivergentSession(client, bundle, installationId))
      continue
    }

    const finalPaths: SessionBundle['paths'] = []
    for (const subpath of subpaths) {
      const sourceEntries = bundle.paths.find((path) => (path.subpath ?? '') === subpath)?.entries ?? []
      const targetEntries = targetPaths.find((path) => (path.subpath ?? '') === subpath)?.entries ?? []
      const finalEntries = targetEntries.length >= sourceEntries.length ? targetEntries : sourceEntries
      for (let index = targetEntries.length; index < sourceEntries.length; index += 1) {
        const entry = sourceEntries[index]
        const normalized = normalizeJson(entry)
        await client.query(
          `INSERT INTO sdk_session_entries(conversation_id, session_id, subpath, sequence, entry_uuid, entry, content_hash)
           VALUES($1, $2, $3, $4, $5, $6, $7)`,
          [
            bundle.conversationId,
            bundle.sessionId,
            subpath,
            index + 1,
            entry.uuid ?? null,
            encodePostgresJson(normalized),
            hashJson(normalized)
          ]
        )
      }
      if (finalEntries.length) {
        finalPaths.push(subpath ? { subpath, entries: finalEntries } : { entries: finalEntries })
      }
    }
    let summary: SessionSummaryEntry | undefined
    for (const path of finalPaths) {
      summary = foldSessionSummary(
        summary,
        { projectKey: bundle.conversationId, sessionId: bundle.sessionId, ...(path.subpath ? { subpath: path.subpath } : {}) },
        path.entries,
        { mtime: bundle.mtime }
      )
    }
    if (summary) {
      await client.query(
        `INSERT INTO sdk_session_summaries(conversation_id, session_id, mtime_ms, data)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(conversation_id, session_id) DO UPDATE SET mtime_ms = EXCLUDED.mtime_ms, data = EXCLUDED.data`,
        [bundle.conversationId, bundle.sessionId, summary.mtime, encodePostgresJson(normalizeJson(summary.data))]
      )
    }
    const verifiedHash = hashJson(normalizeJson(finalPaths))
    await client.query(
      `UPDATE sdk_sessions SET mtime_ms = GREATEST(mtime_ms, $3), sdk_version = '0.3.220',
         verified_hash = $4, resume_ready = true WHERE conversation_id = $1 AND session_id = $2`,
      [bundle.conversationId, bundle.sessionId, bundle.mtime, verifiedHash]
    )
    imported.push({ entity: 'sdk-session', id: `${bundle.conversationId}:${bundle.sessionId}`, contentHash: verifiedHash })
  }
  return imported
}

class ForkTransferStore implements SessionStore {
  private readonly forked = new Map<string, Map<string, SessionStoreEntry[]>>()

  constructor(private readonly source: SessionBundle) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    let paths = this.forked.get(key.sessionId)
    if (!paths) {
      paths = new Map()
      this.forked.set(key.sessionId, paths)
    }
    const subpath = key.subpath ?? ''
    const current = paths.get(subpath) ?? []
    const uuids = new Set(current.flatMap((entry) => typeof entry.uuid === 'string' ? [entry.uuid] : []))
    for (const entry of entries) {
      if (typeof entry.uuid === 'string' && uuids.has(entry.uuid)) continue
      current.push(entry)
      if (typeof entry.uuid === 'string') uuids.add(entry.uuid)
    }
    paths.set(subpath, current)
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    if (key.sessionId === this.source.sessionId) {
      return this.source.paths.find((path) => (path.subpath ?? '') === (key.subpath ?? ''))?.entries ?? null
    }
    return this.forked.get(key.sessionId)?.get(key.subpath ?? '') ?? null
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    if (key.sessionId === this.source.sessionId) {
      return this.source.paths.flatMap((path) => path.subpath ? [path.subpath] : [])
    }
    return [...(this.forked.get(key.sessionId)?.keys() ?? [])].filter(Boolean)
  }

  paths(sessionId: string): SessionBundle['paths'] {
    return [...(this.forked.get(sessionId)?.entries() ?? [])]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([subpath, entries]) => subpath ? { subpath, entries } : { entries })
  }
}

export async function forkSessionBundle(bundle: SessionBundle): Promise<SessionBundle> {
  const store = new ForkTransferStore(bundle)
  const forked = await forkSession(bundle.sessionId, {
    sessionStore: store,
    title: 'Conflito importado'
  }).catch((cause) => {
    throw new StorageError('SESSION_HANDOFF_INCOMPLETE', `Não foi possível preservar o transcript divergente ${bundle.sessionId}.`, false, { cause })
  })
  const paths = store.paths(forked.sessionId)
  if (!paths.length) {
    throw new StorageError('SESSION_HANDOFF_INCOMPLETE', `O fork público de ${bundle.sessionId} não produziu transcript.`)
  }
  return { ...bundle, sessionId: forked.sessionId, paths }
}

async function forkDivergentSession(
  client: PoolClient,
  bundle: SessionBundle,
  installationId: string
): Promise<ImportedSessionItem[]> {
  const forked = await forkSessionBundle(bundle)
  const conflictConversationId = `${bundle.conversationId}-session-conflict-${forked.sessionId.slice(0, 8)}`
  const source = { ...bundle.conversationPayload }
  const title = typeof source.title === 'string' && source.title.trim() ? source.title : 'Conversa'
  const device: Record<string, unknown> = {}
  if (typeof source.cwd === 'string') device.cwd = source.cwd
  if (typeof source.draft === 'string') device.draft = source.draft
  delete source.cwd
  delete source.draft
  const shared = normalizeJson({
    ...source,
    id: conflictConversationId,
    sdkSessionId: forked.sessionId,
    title: `${title} (sessão divergente importada)`,
    legacyConflictOf: bundle.conversationId
  }) as Record<string, unknown>
  const conversationHash = hashJson(shared as JsonValue)
  await client.query(
    `INSERT INTO conversations(conversation_id, project_id, payload, revision, content_hash, updated_by)
     VALUES($1, $2, $3, 1, $4, $5)`,
    [
      conflictConversationId,
      typeof shared.projectId === 'string' ? shared.projectId : null,
      encodePostgresJson(normalizeJson(shared)),
      conversationHash,
      installationId
    ]
  )
  await client.query(
    `INSERT INTO conversation_device_state(conversation_id, installation_id, state, revision)
     VALUES($1, $2, $3, 1)`,
    [conflictConversationId, installationId, encodePostgresJson(normalizeJson(device))]
  )
  const sessionItems = await importSessions(client, [{
    conversationId: conflictConversationId,
    sessionId: forked.sessionId,
    mtime: bundle.mtime,
    conversationPayload: shared,
    paths: forked.paths
  }], installationId)
  return [
    { entity: 'conversation', id: conflictConversationId, contentHash: conversationHash },
    ...sessionItems
  ]
}
