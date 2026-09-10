import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { memorySummary } from '../memoryIndex'
import { hashText } from '../persistence/hashes'
import { StorageError, type MemoryEntry, type MemoryEntryStatus, type MemoryEntryWrite, type MemoryProposal, type MemoryProposalQuery, type MemoryRepository } from '../persistence/types'
import { MEMORY_INDEX_FILENAME, MEMORY_PROPOSAL_MAX_ATTEMPTS, MEMORY_RETIRED_DIRNAME, normalizeMemoryProposal, normalizeMemoryRelPath, parseMemoryIndexBullets, renderMemoryIndexFile, type MemoryProposeInput } from './memoryModel'

export type { MemoryProposeInput } from './memoryModel'
export interface MemoryServiceOptions { log?: (line: string) => void }
type ApplyOutcome = 'applied' | 'conflict' | 'rejected' | 'requeued' | 'uncertain'
export interface ApplyPendingSummary {
  applied: number
  conflict: number
  rejected: number
  requeued: number
  /** Settlement could not be confirmed; the database may already have committed. */
  uncertain: number
  /** Projection failures are independent of successfully committed proposals. */
  projectionConflicts: MemoryProjectionConflict[]
}
export interface MemoryProjectionConflict { relPath: string; reason: string }
export interface MemoryReconcileSummary { imported: number; conflicts: MemoryProjectionConflict[] }

const JOURNAL = '.memory-projection.json'
const LEGACY_INDEX = '.memory-legacy-index.md'
interface ProjectionJournal { version: 1; files: Record<string, string[]> }
// Instances in this process sharing a local root must never race their journals or projections.
// This is NOT a distributed lock: independent processes/machines/OneDrive can still race.
// Run a single local writer. File checks reject existing links, not hostile concurrent link swaps.
const rootChains = new Map<string, Promise<unknown>>()

/**
 * Database-first, offline-only service. Entry CAS and proposal settlement are one repository
 * transaction; Markdown is replayable projection, never evidence of a successful proposal.
 * A local journal records the last projected hash and an in-flight replacement hash BEFORE
 * replacement. Thus a crash before/after rename is replayable without importing stale content.
 * Unknown legacy files are imported once; known drift is preserved and reported, never imported.
 * The journal is local evidence, not a cross-device consensus protocol. Losing/corrupting it
 * fails conservatively (divergence needs manual resolution). An edit identical to a recorded
 * projection is inherently indistinguishable from that projection. No vault hook/startup wiring
 * exists here: live use must wait for secret-vault integration.
 */
export class MemoryService {
  private readonly repository: MemoryRepository
  private readonly log: (line: string) => void
  readonly memoriesDir: string

  constructor(repository: MemoryRepository, memoriesDir: string, options: MemoryServiceOptions = {}) {
    this.repository = repository
    this.memoriesDir = resolve(memoriesDir)
    this.log = options.log ?? (() => undefined)
  }

  async propose(input: MemoryProposeInput): Promise<MemoryProposal> {
    const normalized = normalizeMemoryProposal(this.memoriesDir, input)
    if (input.op !== 'create' && input.scope === undefined) {
      const existing = await this.repository.getMemoryEntryByPath(normalized.relPath)
      if (existing) normalized.scope = existing.scope
    }
    await this.checkPath(this.fullPath(normalized.relPath))
    return this.repository.enqueueMemoryProposal(normalized)
  }

  listProposals(query?: MemoryProposalQuery): Promise<MemoryProposal[]> { return this.repository.listMemoryProposals(query) }
  listEntries(query?: { status?: MemoryEntryStatus }): Promise<MemoryEntry[]> { return this.repository.listMemoryEntries(query) }
  applyPending(): Promise<ApplyPendingSummary> { return this.serialize(() => this.drain()) }
  reconcile(): Promise<MemoryReconcileSummary> { return this.serialize(() => this.reconcileNow()) }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const key = process.platform === 'win32' ? this.memoriesDir.toLowerCase() : this.memoriesDir
    const previous = rootChains.get(key) ?? Promise.resolve()
    const next = previous.then(work, work)
    const finished = next.catch(() => undefined)
    rootChains.set(key, finished)
    void finished.then(() => { if (rootChains.get(key) === finished) rootChains.delete(key) })
    return next
  }

  private async drain(): Promise<ApplyPendingSummary> {
    // Establish baselines/import legacy files before any proposal can claim their paths.
    const before = await this.reconcileNow()
    const summary: ApplyPendingSummary = { applied: 0, conflict: 0, rejected: 0, requeued: 0, uncertain: 0, projectionConflicts: [] }
    // Snapshot-sized, bounded pass. A failed settlement/requeue must not be claimed forever.
    const budget = (await this.repository.listMemoryProposals({ status: 'pending', limit: 1000 })).length
    for (let i = 0; i < budget; i++) {
      const claim = await this.repository.claimMemoryProposal()
      if (!claim) break
      const outcome = await this.applyOne(claim.proposal, claim.token)
      summary[outcome]++
      if (outcome === 'requeued' || outcome === 'uncertain') break
    }
    // Also repairs commits from a previous process that crashed before projecting anything.
    const after = await this.reconcileNow()
    const conflicts = new Map<string, MemoryProjectionConflict>()
    for (const conflict of [...before.conflicts, ...after.conflicts]) {
      conflicts.set(JSON.stringify([conflict.relPath, conflict.reason]), conflict)
    }
    summary.projectionConflicts = [...conflicts.values()]
    return summary
  }

  private async applyOne(proposal: MemoryProposal, token: string): Promise<ApplyOutcome> {
    const settle = async (input: Parameters<MemoryRepository['settleMemoryProposal']>[0]): Promise<ApplyOutcome> => {
      const result = await this.repository.settleMemoryProposal(input)
      return result.status === 'pending' ? 'requeued' : result.status
    }
    const conflict = (reason: string) => settle({ proposalId: proposal.id, token, outcome: 'conflict', reason })
    try {
      normalizeMemoryProposal(this.memoriesDir, proposal)
      if (proposal.op === 'create' && (await this.repository.listMemoryEntries()).some((entry) => entry.relPath.toLowerCase() === proposal.relPath.toLowerCase())) {
        return await conflict(`${proposal.relPath} colide com uma entrada existente (inclusive aposentada).`)
      }
      await this.checkPath(this.fullPath(proposal.relPath))
      if (proposal.attempts > MEMORY_PROPOSAL_MAX_ATTEMPTS) return await conflict('Limite de tentativas excedido.')
      const existing = await this.repository.getMemoryEntryByPath(proposal.relPath)
      const active = existing?.status === 'active' ? existing : null
      if (proposal.op === 'create' && existing) return await conflict(`${proposal.relPath} já existe ou foi aposentada; create não substitui entradas.`)
      if (proposal.op !== 'create' && !active) return await conflict(`${proposal.relPath} não existe ou foi aposentada.`)
      if (proposal.op !== 'create' && proposal.expectedRevision !== null && proposal.expectedRevision !== active!.revision) {
        return await conflict(`${proposal.relPath} está na revisão ${active!.revision}, não ${proposal.expectedRevision}.`)
      }
      if (proposal.op === 'update' && proposal.expectedRevision === null) return await conflict('Atualização exige expected_revision.')
      const entry: MemoryEntryWrite = {
        relPath: proposal.relPath,
        title: proposal.op === 'retire' ? active!.title : proposal.title ?? active?.title ?? '',
        hook: proposal.op === 'retire' ? active!.hook : proposal.hook ?? active?.hook ?? '',
        scope: proposal.op === 'retire' ? active!.scope : proposal.scope,
        projectCwd: proposal.projectCwd ?? active?.projectCwd ?? null,
        domain: proposal.domain ?? active?.domain ?? null,
        body: proposal.op === 'retire' ? active!.body : proposal.body ?? '',
        status: proposal.op === 'retire' ? 'retired' : 'active',
        originConversationId: proposal.originConversationId,
        originMessageId: proposal.originMessageId,
        originAgent: proposal.originAgent,
        supersedesId: active?.supersedesId ?? null,
        expectedRevision: active?.revision ?? 0
      }
      // No proposed content is written to disk until this transaction commits.
      return await settle({ proposalId: proposal.id, token, outcome: 'applied', entry })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.log(`memory proposal ${proposal.id} failed: ${reason}`)
      try {
        if (error instanceof StorageError && error.code === 'INVALID_PERSISTED_DATA') return await settle({ proposalId: proposal.id, token, outcome: 'rejected', reason })
        if (error instanceof StorageError && error.code === 'REVISION_CONFLICT') return await conflict(reason)
        if (proposal.attempts >= MEMORY_PROPOSAL_MAX_ATTEMPTS) return await conflict(`Falhou ${proposal.attempts} vezes; ${reason}`)
        return await settle({ proposalId: proposal.id, token, outcome: 'requeue', reason })
      } catch (settleError) {
        // Unknown commit outcome: do NOT write files or claim again in this pass.
        this.log(`memory proposal ${proposal.id} settlement unavailable: ${String(settleError)}`)
        return 'uncertain'
      }
    }
  }

  private fullPath(relPath: string): string {
    return join(this.memoriesDir, ...normalizeMemoryRelPath(this.memoriesDir, relPath, { kebab: false }).split('/'))
  }

  /** Check every existing ancestor (including ancestors of the configured root). */
  private async checkPath(path: string): Promise<void> {
    const absolute = resolve(path)
    const root = parse(absolute).root
    let cursor = root
    const segments = absolute.slice(root.length).split(/[\\/]/).filter(Boolean)
    for (let i = 0; i < segments.length; i++) {
      cursor = join(cursor, segments[i])
      try {
        const stat = await lstat(cursor)
        if (stat.isSymbolicLink() || (i < segments.length - 1 && !stat.isDirectory())) {
          throw new Error(`Unsafe memory path (symlink/non-directory): ${cursor}`)
        }
        if (i === segments.length - 1 && !stat.isDirectory() && !stat.isFile()) throw new Error(`Unsafe memory file: ${cursor}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
    }
  }

  private async read(path: string): Promise<string | null> {
    await this.checkPath(path)
    try { return await readFile(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async writeAtomic(path: string, content: string): Promise<void> {
    await this.checkPath(path)
    await mkdir(dirname(path), { recursive: true })
    await this.checkPath(path)
    const tmp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' })
      await this.checkPath(path)
      await rename(tmp, path)
    } finally { await unlink(tmp).catch(() => undefined) }
  }

  private async loadJournal(): Promise<ProjectionJournal> {
    const raw = await this.read(join(this.memoriesDir, JOURNAL))
    if (raw === null) return { version: 1, files: Object.create(null) as Record<string, string[]> }
    const journal = JSON.parse(raw) as ProjectionJournal
    if (journal.version !== 1 || !journal.files || Array.isArray(journal.files) || typeof journal.files !== 'object' ||
      Object.values(journal.files).some((hashes) => !Array.isArray(hashes) || hashes.length > 2 || hashes.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))) {
      throw new Error('Invalid memory projection journal; refusing to overwrite local files.')
    }
    return journal
  }

  private saveJournal(journal: ProjectionJournal): Promise<void> {
    return this.writeAtomic(join(this.memoriesDir, JOURNAL), JSON.stringify(journal))
  }

  private report(summary: MemoryReconcileSummary, relPath: string, reason: string): void {
    summary.conflicts.push({ relPath, reason })
    this.log(`memory projection conflict ${relPath}: ${reason}`)
  }

  private async project(relPath: string, content: string, journal: ProjectionJournal, summary: MemoryReconcileSummary): Promise<boolean> {
    const path = join(this.memoriesDir, ...relPath.split('/'))
    const current = await this.read(path)
    const hash = hashText(content)
    const prior = Object.hasOwn(journal.files, relPath) ? journal.files[relPath] : []
    if (current !== null && current !== content && !prior.includes(hashText(current))) {
      this.report(summary, relPath, 'Local file diverged; preserved without importing or overwriting.')
      return false
    }
    if (current !== content) {
      // WAL for the projection only: tolerate either side of a crash around rename.
      journal.files[relPath] = [...new Set([...(current === null ? [] : [hashText(current)]), hash])]
      await this.saveJournal(journal)
      // Detect edits during journal I/O. There is still a TOCTOU window against external writers.
      if (await this.read(path) !== current) {
        journal.files[relPath] = prior
        await this.saveJournal(journal)
        this.report(summary, relPath, 'Local file changed during projection; retry reconciliation.')
        return false
      }
      await this.writeAtomic(path, content)
    }
    journal.files[relPath] = [hash]
    await this.saveJournal(journal)
    return true
  }

  private async legacyFiles(summary: MemoryReconcileSummary, prefix = ''): Promise<string[]> {
    const directory = join(this.memoriesDir, prefix)
    await this.checkPath(directory)
    const files: string[] = []
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relPath = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isSymbolicLink()) { this.report(summary, relPath, 'Symlink skipped.'); continue }
      if (item.name.startsWith('.')) continue
      if (item.isDirectory()) files.push(...await this.legacyFiles(summary, relPath))
      else if (item.isFile() && item.name.toLowerCase().endsWith('.md') && relPath.toLowerCase() !== MEMORY_INDEX_FILENAME.toLowerCase()) {
        try { normalizeMemoryRelPath(this.memoriesDir, relPath, { kebab: false }); files.push(relPath) }
        catch { this.report(summary, relPath, 'Unsafe legacy path skipped.') }
      }
    }
    return files
  }

  private async reconcileNow(): Promise<MemoryReconcileSummary> {
    await this.checkPath(this.memoriesDir)
    await mkdir(this.memoriesDir, { recursive: true })
    const journal = await this.loadJournal()
    const summary: MemoryReconcileSummary = { imported: 0, conflicts: [] }
    const entries = await this.repository.listMemoryEntries()
    const byPath = new Map(entries.map((entry) => [entry.relPath, entry]))
    const index = await this.read(join(this.memoriesDir, MEMORY_INDEX_FILENAME))
    const curated = parseMemoryIndexBullets(index ?? '')
    for (const relPath of await this.legacyFiles(summary)) {
      if ([...byPath.keys()].some((known) => known.toLowerCase() === relPath.toLowerCase())) continue // Includes tombstones and case aliases.
      if (Object.hasOwn(journal.files, relPath)) {
        this.report(summary, relPath, 'Previously managed file has no database entry; not imported.')
        continue
      }
      const body = await this.read(this.fullPath(relPath))
      if (body === null) continue
      const bullet = curated.get(relPath) ?? memorySummary(body, relPath.split('/').at(-1)!)
      try {
        const entry = await this.repository.writeMemoryEntry({ relPath, title: bullet.title, hook: bullet.hook, scope: 'user', projectCwd: null, domain: null, body, status: 'active', originAgent: 'import', expectedRevision: 0 })
        byPath.set(relPath, entry)
        summary.imported++
        journal.files[relPath] = [hashText(body)]
        await this.saveJournal(journal)
      } catch (error) { this.report(summary, relPath, `Legacy import failed: ${String(error)}`) }
    }

    for (const entry of byPath.values()) {
      try {
        this.fullPath(entry.relPath) // Validate even persisted paths before joining anywhere.
        if (entry.status === 'active') await this.project(entry.relPath, entry.body, journal, summary)
        else await this.projectRetired(entry, journal, summary)
      } catch (error) { this.report(summary, entry.relPath, String(error)) }
    }

    // Preserve the FULL original legacy index (including comments/unparsed metadata), not just bullets.
    if (index !== null && !Object.hasOwn(journal.files, MEMORY_INDEX_FILENAME)) {
      const backup = join(this.memoriesDir, LEGACY_INDEX)
      const existing = await this.read(backup)
      if (existing === null) await this.writeAtomic(backup, index)
      if (existing === null || existing === index) {
        journal.files[MEMORY_INDEX_FILENAME] = [hashText(index)]
        await this.saveJournal(journal)
      }
    }
    await this.project(MEMORY_INDEX_FILENAME, renderMemoryIndexFile([...byPath.values()].filter((entry) => entry.status === 'active')), journal, summary)
    return summary
  }

  private async projectRetired(entry: MemoryEntry, journal: ProjectionJournal, summary: MemoryReconcileSummary): Promise<void> {
    const source = this.fullPath(entry.relPath)
    const current = await this.read(source)
    const known = Object.hasOwn(journal.files, entry.relPath) ? journal.files[entry.relPath] : []
    if (current !== null && hashText(current) !== entry.bodyHash && !known.includes(hashText(current))) {
      this.report(summary, entry.relPath, 'Retired path contains divergent content; preserved, never reactivated.')
      return
    }
    if (!await this.project(`${MEMORY_RETIRED_DIRNAME}/${entry.relPath}`, entry.body, journal, summary)) return
    if (current !== null) {
      if (await this.read(source) !== current) { this.report(summary, entry.relPath, 'Retired path changed during projection.'); return }
      await this.checkPath(source)
      await unlink(source)
    }
    // Keep a tombstone in the local journal even if the database later disappears or is switched.
    journal.files[entry.relPath] = [entry.bodyHash]
    await this.saveJournal(journal)
  }
}
