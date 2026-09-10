import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { hashText } from '../persistence/hashes'
import {
  StorageError,
  type MemoryEntry,
  type MemoryEntryStatus,
  type MemoryEntryWrite,
  type MemoryProposal,
  type MemoryProposalCreate,
  type MemoryProposalOp,
  type MemoryProposalStatus,
  type MemoryScope
} from '../persistence/types'

/**
 * Rules shared by the SQLite and PostgreSQL memory stores and by the service:
 * input validation, lease checks, row mapping and the `MEMORY.md` renderer.
 * Everything here is pure so both backends enforce the same contract.
 */

export const MEMORY_SCOPES: readonly MemoryScope[] = ['user', 'project', 'domain']
export const MEMORY_ENTRY_STATUSES: readonly MemoryEntryStatus[] = ['active', 'retired']
export const MEMORY_PROPOSAL_OPS: readonly MemoryProposalOp[] = ['create', 'update', 'retire']
export const MEMORY_PROPOSAL_STATUSES: readonly MemoryProposalStatus[] = ['pending', 'applied', 'rejected', 'conflict']

export const MEMORY_PROPOSAL_LEASE_TTL_MS = 60_000
/** A proposal whose database application keeps failing becomes `conflict` after this many claims. */
export const MEMORY_PROPOSAL_MAX_ATTEMPTS = 3
export const MEMORY_INDEX_FILENAME = 'MEMORY.md'
export const MEMORY_RETIRED_DIRNAME = '.retired'

const KEBAB_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value)
}

export function isMemoryProposalOp(value: unknown): value is MemoryProposalOp {
  return typeof value === 'string' && (MEMORY_PROPOSAL_OPS as readonly string[]).includes(value)
}

function invalid(message: string): StorageError {
  return new StorageError('INVALID_PERSISTED_DATA', message)
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}

/**
 * Normalises a memory path to the `folder/file.md` form used everywhere else
 * (always `/`). Rejects traversal, hidden segments, the root index and anything
 * that resolves outside `memoriesDir`. `kebab` additionally requires every
 * segment to be a kebab-case slug (new files only; legacy names stay updatable).
 */
export function normalizeMemoryRelPath(memoriesDir: string, raw: string, options: { kebab: boolean }): string {
  if (typeof raw !== 'string' || !raw.trim()) throw invalid('rel_path é obrigatório.')
  const value = raw.trim().replace(/\\/g, '/')
  if (/^(?:\/|[a-z]:)/i.test(value) || /[\x00-\x1f<>:"|?*]/.test(value)) throw invalid(`rel_path absoluto ou inválido: ${raw}`)
  const relPath = value.replace(/^\.\//, '')
  if (!relPath.toLowerCase().endsWith('.md')) throw invalid(`rel_path deve terminar em .md: ${raw}`)
  const segments = relPath.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || segment.startsWith('.') || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment))) {
    throw invalid(`rel_path inválido: ${raw}`)
  }
  if (segments.length === 1 && segments[0].toLowerCase() === MEMORY_INDEX_FILENAME.toLowerCase()) {
    throw invalid('MEMORY.md é gerado pelo serviço e não pode ser proposto.')
  }
  if (!pathInside(resolve(memoriesDir), resolve(memoriesDir, ...segments))) {
    throw invalid(`rel_path sai da pasta de memórias: ${raw}`)
  }
  if (options.kebab) {
    const folders = segments.slice(0, -1)
    const stem = segments.at(-1)!.replace(/\.md$/i, '')
    if (!KEBAB_SEGMENT.test(stem) || folders.some((folder) => !KEBAB_SEGMENT.test(folder))) {
      throw invalid(`rel_path deve ser um slug kebab-case (ex.: pasta/minha-memoria.md): ${raw}`)
    }
  }
  return relPath
}

export interface MemoryProposeInput {
  op: MemoryProposalOp
  relPath: string
  title?: string | null
  hook?: string | null
  body?: string | null
  scope?: MemoryScope
  projectCwd?: string | null
  domain?: string | null
  proposedBy: string
  expectedRevision?: number | null
  originConversationId?: string | null
  originMessageId?: string | null
  originAgent?: string | null
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw invalid(`${label} deve ser texto.`)
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** Validation rules for `MemoryService.propose` (spec: path inside memories/, .md, kebab slug, non-empty body). */
export function normalizeMemoryProposal(memoriesDir: string, input: MemoryProposeInput): MemoryProposalCreate {
  if (!isMemoryProposalOp(input.op)) throw invalid(`Operação de memória desconhecida: ${String(input.op)}.`)
  const relPath = normalizeMemoryRelPath(memoriesDir, input.relPath, { kebab: input.op === 'create' })
  const scope = input.scope ?? 'user'
  if (!isMemoryScope(scope)) throw invalid(`Escopo de memória desconhecido: ${String(scope)}.`)
  const proposedBy = typeof input.proposedBy === 'string' ? input.proposedBy.trim() : ''
  if (!proposedBy) throw invalid('proposed_by é obrigatório.')

  const title = optionalText(input.title, 'title')
  const hook = optionalText(input.hook, 'hook')
  const body = typeof input.body === 'string' && input.body.trim() ? input.body : null
  const expectedRevision = input.expectedRevision ?? null
  if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) {
    throw invalid('expected_revision deve ser um inteiro positivo.')
  }

  if (input.op === 'create') {
    if (!title) throw invalid('Memória nova precisa de título.')
    if (!hook) throw invalid('Memória nova precisa de hook (resumo do índice).')
    if (!body) throw invalid('Memória nova precisa de corpo.')
  } else if (input.op === 'update') {
    if (!body) throw invalid('Atualização de memória precisa de corpo.')
    if (expectedRevision === null) throw invalid('Atualização de memória exige expected_revision.')
  }

  return {
    op: input.op,
    relPath,
    title,
    hook,
    body,
    scope,
    projectCwd: optionalText(input.projectCwd, 'project_cwd'),
    domain: optionalText(input.domain, 'domain'),
    proposedBy,
    expectedRevision,
    originConversationId: input.originConversationId ?? null,
    originMessageId: input.originMessageId ?? null,
    originAgent: input.originAgent ?? null
  }
}

export interface NormalizedMemoryEntryWrite {
  relPath: string
  title: string
  hook: string
  scope: MemoryScope
  projectCwd: string | null
  domain: string | null
  body: string
  bodyHash: string
  status: MemoryEntryStatus
  supersedesId: string | null
  originConversationId: string | null
  originMessageId: string | null
  originAgent: string | null
  expectedRevision: number
}

export function normalizeMemoryEntryWrite(write: MemoryEntryWrite): NormalizedMemoryEntryWrite {
  if (typeof write.relPath !== 'string' || !write.relPath.trim()) throw invalid('Entrada de memória precisa de rel_path.')
  if (typeof write.title !== 'string' || !write.title.trim()) throw invalid('Entrada de memória precisa de título.')
  if (typeof write.body !== 'string') throw invalid('Entrada de memória precisa de corpo.')
  if (!isMemoryScope(write.scope)) throw invalid(`Escopo de memória desconhecido: ${String(write.scope)}.`)
  if (!(MEMORY_ENTRY_STATUSES as readonly string[]).includes(write.status)) {
    throw invalid(`Status de memória desconhecido: ${String(write.status)}.`)
  }
  if (!Number.isInteger(write.expectedRevision) || write.expectedRevision < 0) {
    throw invalid('expected_revision deve ser um inteiro não negativo.')
  }
  return {
    relPath: normalizeMemoryRelPath(resolve('.'), write.relPath, { kebab: false }),
    title: write.title.trim(),
    hook: typeof write.hook === 'string' ? write.hook.trim() : '',
    scope: write.scope,
    projectCwd: write.projectCwd ?? null,
    domain: write.domain ?? null,
    body: write.body,
    bodyHash: hashText(write.body),
    status: write.status,
    supersedesId: write.supersedesId ?? null,
    originConversationId: write.originConversationId ?? null,
    originMessageId: write.originMessageId ?? null,
    originAgent: write.originAgent ?? null,
    expectedRevision: write.expectedRevision
  }
}

export function newMemoryId(): string {
  return randomUUID()
}

/** Reject a settlement that applies a different operation/path or bypasses the proposal's CAS. */
export function assertMemoryProposalApplication(proposal: MemoryProposal, write: MemoryEntryWrite): void {
  if (!write || write.relPath !== proposal.relPath || write.status !== (proposal.op === 'retire' ? 'retired' : 'active')) {
    throw invalid('Aplicação não corresponde à operação/caminho da proposta.')
  }
  if (proposal.op === 'create' && write.expectedRevision !== 0) throw invalid('Create exige entrada inexistente.')
  if (proposal.op === 'update' && proposal.expectedRevision === null) throw invalid('Update exige expected_revision.')
  if (proposal.op !== 'create' && (write.expectedRevision < 1 || (proposal.expectedRevision !== null && write.expectedRevision !== proposal.expectedRevision))) {
    throw new StorageError('REVISION_CONFLICT', 'Aplicação não corresponde à revisão esperada pela proposta.')
  }
}

type ProposalLeaseSubject = Pick<MemoryProposal, 'id' | 'status' | 'leaseToken' | 'leaseExpiresAt'>

/** Only the worker holding a live lease may settle a pending proposal. */
export function assertProposalLease(proposal: ProposalLeaseSubject, token: string, nowMs: number): void {
  if (proposal.status !== 'pending') {
    throw new StorageError('REVISION_CONFLICT', `Proposta ${proposal.id} já está em '${proposal.status}'.`)
  }
  const live = proposal.leaseExpiresAt !== null && Date.parse(proposal.leaseExpiresAt) > nowMs
  if (!live || proposal.leaseToken !== token) {
    throw new StorageError('REVISION_CONFLICT', `Lease da proposta ${proposal.id} expirou ou pertence a outro worker.`)
  }
}

// ---------------------------------------------------------------------------
// Row mapping (SQLite: ISO text + integers; PostgreSQL: Date + bigint-as-string)
// ---------------------------------------------------------------------------

type TimeColumn = Date | string
type IntColumn = number | bigint | string

function isoColumn(value: TimeColumn): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function optionalIso(value: TimeColumn | null): string | null {
  return value === null || value === undefined ? null : isoColumn(value)
}

function optionalInt(value: IntColumn | null): number | null {
  return value === null || value === undefined ? null : Number(value)
}

export interface MemoryEntryRow {
  id: string
  rel_path: string
  title: string
  hook: string
  scope: string
  project_cwd: string | null
  domain: string | null
  body: string
  body_hash: string
  revision: IntColumn
  status: string
  origin_conversation_id: string | null
  origin_message_id: string | null
  origin_agent: string | null
  supersedes_id: string | null
  created_at: TimeColumn
  updated_at: TimeColumn
}

export interface MemoryProposalRow {
  id: string
  entry_id: string | null
  op: string
  rel_path: string
  title: string | null
  hook: string | null
  body: string | null
  scope: string
  project_cwd: string | null
  domain: string | null
  origin_conversation_id: string | null
  origin_message_id: string | null
  origin_agent: string | null
  status: string
  reason: string | null
  proposed_by: string
  expected_revision: IntColumn | null
  attempts: IntColumn
  lease_token: string | null
  lease_expires_at: TimeColumn | null
  created_at: TimeColumn
  updated_at: TimeColumn
}

export const MEMORY_ENTRY_COLUMNS = `id, rel_path, title, hook, scope, project_cwd, domain, body, body_hash, revision, status,
  origin_conversation_id, origin_message_id, origin_agent, supersedes_id, created_at, updated_at`
export const MEMORY_PROPOSAL_COLUMNS = `id, entry_id, op, rel_path, title, hook, body, scope, project_cwd, domain,
  origin_conversation_id, origin_message_id, origin_agent, status, reason, proposed_by, expected_revision, attempts,
  lease_token, lease_expires_at, created_at, updated_at`

export function memoryEntryFromRow(row: MemoryEntryRow): MemoryEntry {
  if (!isMemoryScope(row.scope)) throw invalid(`Escopo de memória persistido inválido: ${row.scope}.`)
  if (!(MEMORY_ENTRY_STATUSES as readonly string[]).includes(row.status)) {
    throw invalid(`Status de memória persistido inválido: ${row.status}.`)
  }
  return {
    id: row.id,
    relPath: row.rel_path,
    title: row.title,
    hook: row.hook,
    scope: row.scope,
    projectCwd: row.project_cwd,
    domain: row.domain,
    body: row.body,
    bodyHash: row.body_hash,
    revision: Number(row.revision),
    status: row.status as MemoryEntryStatus,
    originConversationId: row.origin_conversation_id,
    originMessageId: row.origin_message_id,
    originAgent: row.origin_agent,
    supersedesId: row.supersedes_id,
    createdAt: isoColumn(row.created_at),
    updatedAt: isoColumn(row.updated_at)
  }
}

export function memoryProposalFromRow(row: MemoryProposalRow): MemoryProposal {
  if (!isMemoryProposalOp(row.op)) throw invalid(`Operação de proposta persistida inválida: ${row.op}.`)
  if (!isMemoryScope(row.scope)) throw invalid(`Escopo de proposta persistido inválido: ${row.scope}.`)
  if (!(MEMORY_PROPOSAL_STATUSES as readonly string[]).includes(row.status)) {
    throw invalid(`Status de proposta persistido inválido: ${row.status}.`)
  }
  return {
    id: row.id,
    entryId: row.entry_id,
    op: row.op,
    relPath: row.rel_path,
    title: row.title,
    hook: row.hook,
    body: row.body,
    scope: row.scope,
    projectCwd: row.project_cwd,
    domain: row.domain,
    originConversationId: row.origin_conversation_id,
    originMessageId: row.origin_message_id,
    originAgent: row.origin_agent,
    status: row.status as MemoryProposalStatus,
    reason: row.reason,
    proposedBy: row.proposed_by,
    expectedRevision: optionalInt(row.expected_revision),
    attempts: Number(row.attempts),
    leaseToken: row.lease_token,
    leaseExpiresAt: optionalIso(row.lease_expires_at),
    createdAt: isoColumn(row.created_at),
    updatedAt: isoColumn(row.updated_at)
  }
}

// ---------------------------------------------------------------------------
// MEMORY.md — generated from the active entries, never edited by hand.
// ---------------------------------------------------------------------------

export const MEMORY_INDEX_NOTICE =
  '<!-- Índice gerado pelo Agent Code a partir do banco de memórias. Edite as memórias, não este arquivo. -->'

type IndexBullet = Pick<MemoryEntry, 'relPath' | 'title' | 'hook'>

/** Same shape as `memoryIndexLine` (memoryIndex.ts) but without the length cap:
 *  the root index is injected verbatim into every conversation today and the
 *  user's hand-written hooks are longer than the cap, so truncating here would
 *  silently lose them on import. */
export function memoryIndexBullet(entry: IndexBullet): string {
  return `- [${entry.title}](${entry.relPath}) — ${entry.hook}`
}

/** Root memories first, then one `## <folder>` section per subfolder — the
 *  grouping `renderMemoryIndex` also surfaces. Sorted by path so the output is
 *  deterministic across backends. */
export function renderMemoryIndexFile(entries: readonly IndexBullet[]): string {
  const sorted = [...entries].sort((a, b) => a.relPath.localeCompare(b.relPath))
  const root: string[] = []
  const grouped = new Map<string, string[]>()
  for (const entry of sorted) {
    const slash = entry.relPath.lastIndexOf('/')
    if (slash === -1) {
      root.push(memoryIndexBullet(entry))
      continue
    }
    const folder = entry.relPath.slice(0, slash)
    const bucket = grouped.get(folder)
    if (bucket) bucket.push(memoryIndexBullet(entry))
    else grouped.set(folder, [memoryIndexBullet(entry)])
  }
  const blocks = [MEMORY_INDEX_NOTICE]
  if (root.length) blocks.push(root.join('\n'))
  for (const [folder, bullets] of grouped) blocks.push(`## ${folder}\n\n${bullets.join('\n')}`)
  return `${blocks.join('\n\n')}\n`
}

const INDEX_BULLET = /^- \[(.+?)\]\(([^)]+\.md)\) — (.*)$/i

/** Title + hook per path from an existing (hand-written) MEMORY.md, so the
 *  import keeps the user's curated bullets instead of re-deriving them. */
export function parseMemoryIndexBullets(markdown: string): Map<string, { title: string; hook: string }> {
  const out = new Map<string, { title: string; hook: string }>()
  for (const line of markdown.split(/\r?\n/)) {
    const match = INDEX_BULLET.exec(line.trim())
    if (!match) continue
    const relPath = match[2].replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!out.has(relPath)) out.set(relPath, { title: match[1].trim(), hook: match[3].trim() })
  }
  return out
}
