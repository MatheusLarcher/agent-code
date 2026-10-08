import { CENTRAL_ID } from '../../../shared/central'
import type { ConversationChangeDto, ConversationSaveStatusDto } from '../../../shared/ipc'
import type { LeaseRenewal } from '../conversationWriteRecovery'
import { isTransientPostgresError } from '../postgresRetry'
import type { ProjectIdentity } from '../projectIdentity'
import {
  StorageError,
  type ConversationQuery,
  type ConversationRecord,
  type LeaseFence,
  type PersistenceRepository,
  type VersionedConversation
} from '../types'
import { applyConversationChange } from './conversationChange'
import type { ConversationJournal, JournalEntry } from './conversationJournal'
import { deleteConversationDoc, knownFrom, mergeCentralPayload, writeConversationDoc, type KnownRecord } from './conversationWrite'
import type { ConversationPreparer } from './preparer'

export interface ConversationWriteQueueDeps {
  /** O repositório ativo; `null` sem banco (offline, fechando). */
  repository(): PersistenceRepository | null
  preparer: ConversationPreparer
  journal: ConversationJournal
  lease(id: string): { fence: LeaseFence; renew?: LeaseRenewal } | undefined
  identity(cwd: string): Promise<ProjectIdentity>
  installationId(): string | null
  onStatus(status: ConversationSaveStatusDto): void
  /** O main não tem a base que a mudança supõe: a tela manda a conversa inteira. */
  onResync(id: string): void
  onCentralRemote(record: VersionedConversation): void
  log?(line: string): void
}

/** Ritmo por conversa durante o streaming: no máximo uma gravação por segundo. */
const THROTTLE_MS = 1_000
/** Primeira gravação depois de ociosa: junta a rajada de mudanças que chega junto. */
const COALESCE_MS = 150
/** O que não chegou ao banco em 3 s vai para o diário local. */
const JOURNAL_AFTER_MS = 3_000
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const STATUS_INTERVAL_MS = 250

interface Entry {
  id: string
  doc: ConversationRecord | null
  deleted: boolean
  /** Sobe a cada mudança; `writtenVersion` alcança quando o banco tem a mais nova. */
  version: number
  writtenVersion: number
  journaledVersion: number
  /** Quando chegou a mudança mais antiga ainda não gravada (ms). */
  since: number | null
  urgent: boolean
  writing: Promise<void> | null
  lastWriteAt: number
  timer: ReturnType<typeof setTimeout> | null
  failures: number
  /** Próxima tentativa depois de uma falha (espera crescente); 0 = sem espera. */
  retryAt: number
  /** Recusa definitiva do banco: para de tentar até a próxima mudança. */
  error: string | null
}

export interface ConversationQueueStats {
  written: number
  unchanged: number
  failed: number
  maxWaitMs: number
}

function retryable(error: unknown): boolean {
  return error instanceof StorageError ? error.retryable : isTransientPostgresError(error)
}

/** Conflito que sobrou dos rebases: disputa com outro writer, não recusa — tenta de novo. */
function contended(error: unknown): boolean {
  return error instanceof StorageError && error.code === 'REVISION_CONFLICT'
}

function iso(value: unknown): string {
  return new Date(typeof value === 'number' && Number.isFinite(value) ? value : Date.now()).toISOString()
}

function matches(doc: ConversationRecord, query: ConversationQuery | undefined): boolean {
  if (query?.ids) return query.ids.includes(String(doc.id))
  if (query?.cwd !== undefined) return doc.cwd === query.cwd
  if (query?.cwds) return query.cwds.includes(typeof doc.cwd === 'string' ? doc.cwd : '')
  return true
}

/**
 * A fila de gravação de conversas: dona de toda escrita de conversa no banco. A
 * tela entrega a mudança e segue; aqui ela vira o instantâneo pendente da conversa
 * (a última versão vence) e é gravada em segundo plano — ~1 vez por segundo no
 * streaming, na hora quando urgente —, na ordem, uma gravação por conversa de cada
 * vez. Sem banco, espera; o que não drena em 3 s vai para o diário local.
 */
export class ConversationWriteQueue {
  private readonly entries = new Map<string, Entry>()
  private readonly known = new Map<string, KnownRecord>()
  private offline = false
  private lastError: string | null = null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private journalTimer: ReturnType<typeof setInterval> | null = null
  private stats: ConversationQueueStats = { written: 0, unchanged: 0, failed: 0, maxWaitMs: 0 }
  private disposed = false

  constructor(private readonly deps: ConversationWriteQueueDeps) {}

  /** Mudanças da tela (já validadas): aplicadas na hora, gravadas depois. */
  apply(changes: ConversationChangeDto[]): void {
    for (const change of changes) {
      const entry = this.entry(change.id)
      if (change.deleted) {
        entry.deleted = true
        entry.doc = null
      } else {
        const next = applyConversationChange(entry.doc ?? undefined, change)
        if (!next) {
          this.deps.onResync(change.id)
          continue
        }
        entry.doc = next
        entry.deleted = false
      }
      entry.version += 1
      entry.since ??= Date.now()
      entry.error = null
      if (change.urgent) entry.urgent = true
      this.schedule(entry)
    }
    this.statusChanged()
  }

  /** Revisões vistas numa leitura: base do próximo compare-and-set (nunca regride). */
  remember(records: VersionedConversation[]): void {
    for (const record of records) {
      const current = this.known.get(record.id)
      if (current && record.revision < current.revision) continue
      if (current && record.revision === current.revision && (record.id !== CENTRAL_ID || current.central)) continue
      this.known.set(record.id, { ...knownFrom(record), ...(current?.deviceHash ? { deviceHash: current.deviceHash } : {}) })
    }
  }

  /** Uma leitura vê o que está na fila: sem isto, recarregar a tela com gravação
   *  pendente mostraria (e depois regravaria) a versão velha do banco. */
  overlay(records: VersionedConversation[], query?: ConversationQuery): VersionedConversation[] {
    const seen = new Set<string>()
    const out: VersionedConversation[] = []
    for (const record of records) {
      seen.add(record.id)
      const entry = this.entries.get(record.id)
      if (!entry || !this.pending(entry)) out.push(record)
      else if (entry.deleted) out.push({ ...record, deletedAt: record.deletedAt ?? new Date().toISOString() })
      else if (entry.doc) {
        const { deletedAt: _deletedAt, ...live } = record
        // A Central é de dois PCs: o pendente daqui vale só para as entradas daqui.
        const payload = record.id === CENTRAL_ID && !record.deletedAt
          ? mergeCentralPayload(entry.doc, record.payload, this.deps.installationId())
          : entry.doc
        out.push({ ...live, payload })
      }
    }
    for (const entry of this.entries.values()) {
      if (seen.has(entry.id) || !this.pending(entry) || entry.deleted || !entry.doc || !matches(entry.doc, query)) continue
      out.push({
        id: entry.id,
        payload: entry.doc,
        revision: 0,
        contentHash: '',
        createdAt: iso(entry.doc.createdAt),
        updatedAt: iso(entry.doc.updatedAt)
      })
    }
    return out
  }

  /** Conversa com gravação pendente: o feed de mudanças não a sobrescreve. */
  isPending(id: string): boolean {
    const entry = this.entries.get(id)
    return entry ? this.pending(entry) : false
  }

  /** O instantâneo que a fila tem da conversa (leitura barata, para quem precisa). */
  snapshot(id: string): ConversationRecord | undefined {
    return this.entries.get(id)?.doc ?? undefined
  }

  /** Abertura: o que ficou no diário da sessão anterior volta como pendente — antes
   *  de a tela ler conversas, para a leitura já vir com ele por cima. */
  async restoreJournal(): Promise<number> {
    const journaled = await this.deps.journal.loadAll()
    this.restore(journaled)
    return journaled.length
  }

  /** O que ficou no diário na sessão anterior: volta como pendente. */
  restore(journaled: JournalEntry[]): void {
    for (const item of journaled) {
      const entry = this.entry(item.id)
      if (this.pending(entry)) continue
      entry.doc = item.deleted ? null : item.doc
      entry.deleted = item.deleted
      entry.version += 1
      entry.journaledVersion = entry.version
      entry.since = item.since
      this.schedule(entry)
    }
    this.statusChanged()
  }

  /** O banco voltou (ou mudou): tenta já o que estava esperando. */
  kick(): void {
    for (const entry of this.entries.values()) {
      if (!this.hasWork(entry) || entry.writing) continue
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
      entry.failures = 0
      entry.retryAt = 0
      this.schedule(entry, 0)
    }
  }

  /** Grava já as conversas pedidas (ou todas), esperando no máximo `deadlineMs`.
   *  `true` = tudo no banco. Sem banco, não espera. */
  async flush(ids: string[] | null, deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const targets = [...this.entries.values()].filter((entry) => (!ids || ids.includes(entry.id)) && this.pending(entry))
      if (!targets.length) return true
      // Recusa definitiva não vira espera até o prazo.
      if (targets.every((entry) => entry.error && !entry.writing)) return false
      if (Date.now() >= deadline || !this.deps.repository()) return false
      for (const entry of targets) {
        entry.urgent = true
        entry.retryAt = 0
        if (!entry.writing) {
          if (entry.timer) clearTimeout(entry.timer)
          entry.timer = null
          void this.run(entry)
        }
      }
      const remaining = deadline - Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.all(targets.map((entry) => entry.writing ?? Promise.resolve())),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, remaining))))
      ])
      if (timer) clearTimeout(timer)
      // Banco caindo: uma tentativa falhou e a próxima só vem depois da espera. Quem
      // chamou (fechamento, início de sessão) segue sem martelar o banco até o prazo.
      if (targets.some((entry) => !entry.writing && entry.retryAt > Date.now())) return false
    }
  }

  /** Só sobrou recusa definitiva (ex.: a pasta da conversa não existe): nenhuma espera
   *  resolve, então isso não segura uma troca de banco nem uma restauração. */
  onlyRefusedLeft(): boolean {
    const pending = [...this.entries.values()].filter((entry) => this.pending(entry))
    return pending.length > 0 && pending.every((entry) => entry.error && !entry.writing)
  }

  /** Fechamento: o que não está no banco vai inteiro para o diário. A recusa
   *  definitiva fica de fora: reaplicada, falharia de novo a cada abertura. */
  async journalPending(): Promise<number> {
    const pending = [...this.entries.values()].filter((entry) => entry.version > entry.writtenVersion && !entry.error)
    await Promise.all(pending.map((entry) => this.journal(entry)))
    return pending.length
  }

  status(): ConversationSaveStatusDto {
    const pending = [...this.entries.values()].filter((entry) => this.pending(entry))
    const oldest = pending.reduce((min, entry) => Math.min(min, entry.since ?? Date.now()), Date.now())
    const blocked = pending.find((entry) => entry.error)
    const state = !pending.length ? 'saved' : blocked ? 'error' : this.offline ? 'offline' : 'pending'
    return {
      state,
      pending: pending.length,
      oldestMs: pending.length ? Date.now() - oldest : 0,
      ...(blocked?.error ? { error: blocked.error } : state === 'saved' || !this.lastError ? {} : { error: this.lastError })
    }
  }

  /** Números desde a última chamada (log periódico). */
  takeStats(): ConversationQueueStats {
    const current = this.stats
    this.stats = { written: 0, unchanged: 0, failed: 0, maxWaitMs: 0 }
    return current
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer)
    if (this.statusTimer) clearTimeout(this.statusTimer)
    if (this.journalTimer) clearInterval(this.journalTimer)
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = {
        id, doc: null, deleted: false, version: 0, writtenVersion: 0, journaledVersion: 0, since: null,
        urgent: false, writing: null, lastWriteAt: 0, timer: null, failures: 0, retryAt: 0, error: null
      }
      this.entries.set(id, entry)
    }
    return entry
  }

  private hasWork(entry: Entry): boolean {
    return entry.version > entry.writtenVersion && !entry.error && (entry.deleted || entry.doc !== null)
  }

  private pending(entry: Entry): boolean {
    return entry.version > entry.writtenVersion || entry.writing !== null
  }

  private schedule(entry: Entry, delay?: number): void {
    if (this.disposed || entry.writing || !this.hasWork(entry)) return
    const now = Date.now()
    const paced = entry.urgent ? 0 : Math.max(COALESCE_MS, entry.lastWriteAt + THROTTLE_MS - now)
    // Depois de uma falha, nem a urgência fura a espera: o banco está indisponível.
    const wait = Math.max(delay ?? paced, entry.retryAt - now, 0)
    if (entry.timer) {
      if (wait > 0 && delay === undefined) return // o agendado já cobre esta mudança
      clearTimeout(entry.timer)
    }
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.run(entry)
    }, wait)
    entry.timer.unref?.()
    this.ensureJournalTimer()
  }

  private run(entry: Entry): Promise<void> {
    if (entry.writing) return entry.writing
    if (!this.hasWork(entry)) return Promise.resolve()
    const work = this.write(entry).finally(() => {
      entry.writing = null
      this.schedule(entry)
      this.statusChanged()
    })
    entry.writing = work
    return work
  }

  private async write(entry: Entry): Promise<void> {
    const repository = this.deps.repository()
    if (!repository) {
      this.offline = true
      entry.failures += 1
      this.retryLater(entry)
      return
    }
    const version = entry.version
    const urgent = entry.urgent
    entry.urgent = false
    entry.lastWriteAt = Date.now()
    const ctx = {
      repository,
      preparer: this.deps.preparer,
      lease: this.deps.lease(entry.id),
      identity: this.deps.identity,
      installationId: this.deps.installationId()
    }
    try {
      const outcome = entry.deleted
        ? await deleteConversationDoc(ctx, entry.id, this.known.get(entry.id))
        : await writeConversationDoc(ctx, entry.doc as ConversationRecord, this.known.get(entry.id))
      this.offline = false
      this.lastError = null
      this.known.set(entry.id, outcome.known)
      if (outcome.centralRemote) this.deps.onCentralRemote(outcome.centralRemote)
      if (outcome.kind === 'unchanged') this.stats.unchanged += 1
      else this.stats.written += 1
      entry.failures = 0
      entry.retryAt = 0
      entry.writtenVersion = Math.max(entry.writtenVersion, version)
      if (entry.writtenVersion >= entry.version) {
        if (entry.since !== null) this.stats.maxWaitMs = Math.max(this.stats.maxWaitMs, Date.now() - entry.since)
        entry.since = null
        if (entry.journaledVersion) {
          entry.journaledVersion = 0
          void this.deps.journal.remove(entry.id).catch(() => undefined)
        }
      }
    } catch (error) {
      this.stats.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      if (contended(error) || retryable(error)) {
        if (!contended(error)) this.offline = true
        entry.urgent = entry.urgent || urgent
        entry.failures += 1
        this.retryLater(entry)
        this.deps.log?.(`[fila] ${entry.id}: ${contended(error) ? 'conflito de revisão' : 'banco indisponível'}, nova tentativa (${message})`)
      } else {
        entry.error = message
        this.lastError = message
        this.deps.log?.(`[fila] ${entry.id}: gravação recusada (${message})`)
      }
    }
  }

  /** Marca a próxima tentativa; quem agenda é o `finally` do `run`, que respeita a marca. */
  private retryLater(entry: Entry): void {
    const step = Math.min(Math.max(entry.failures - 1, 0), RETRY_DELAYS_MS.length - 1)
    entry.retryAt = Date.now() + RETRY_DELAYS_MS[step]
  }

  private ensureJournalTimer(): void {
    if (this.journalTimer || this.disposed) return
    this.journalTimer = setInterval(() => {
      const now = Date.now()
      let waiting = false
      for (const entry of this.entries.values()) {
        if (entry.version <= entry.writtenVersion || entry.error) continue
        waiting = true
        if (entry.since !== null && now - entry.since >= JOURNAL_AFTER_MS && entry.journaledVersion < entry.version) {
          void this.journal(entry)
        }
      }
      if (!waiting && this.journalTimer) {
        clearInterval(this.journalTimer)
        this.journalTimer = null
      }
      this.statusChanged()
    }, 1_000)
    this.journalTimer.unref?.()
  }

  private async journal(entry: Entry): Promise<void> {
    const version = entry.version
    if (entry.journaledVersion >= version || (!entry.deleted && !entry.doc)) return
    try {
      await this.deps.journal.save({ id: entry.id, deleted: entry.deleted, doc: entry.deleted ? null : entry.doc, since: entry.since ?? Date.now() })
      entry.journaledVersion = Math.max(entry.journaledVersion, version)
      // Gravou no banco enquanto o diário era escrito: o arquivo já não vale.
      if (entry.writtenVersion >= entry.version) void this.deps.journal.remove(entry.id).catch(() => undefined)
    } catch (error) {
      this.deps.log?.(`[fila] diário de ${entry.id} falhou: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private statusChanged(): void {
    if (this.statusTimer || this.disposed) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.deps.onStatus(this.status())
    }, STATUS_INTERVAL_MS)
    this.statusTimer.unref?.()
  }
}
