import { isTransientPostgresError } from '../postgresRetry'
import { StorageError, type ConversationOutboxRepository } from '../types'
import type { ConversationJournal } from './conversationJournal'

/** Uma rajada de mudanças na fila de espera vira uma gravação. */
const COALESCE_MS = 150
/** O que não chegou ao banco em 3 s vai para o diário local. */
const JOURNAL_AFTER_MS = 3_000
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

type Items = ReadonlyArray<{ id: string; payload: unknown }>

interface Entry {
  items: Items
  version: number
  writtenVersion: number
  journaledVersion: number
  since: number
  failures: number
  retryAt: number
  writing: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
}

export interface OutboxQueueDeps {
  /** O repositório gravável; `null` sem banco (a fila espera). */
  repository(): ConversationOutboxRepository | null
  /** Diário das filas que não chegaram ao banco (pasta própria, `fila/outbox`). */
  journal: ConversationJournal
  log?(line: string): void
}

function retryable(error: unknown): boolean {
  return error instanceof StorageError ? error.retryable : isTransientPostgresError(error)
}

/**
 * A fila de espera das conversas (mensagens enviadas com o agente ocupado) pela
 * fila do main: a tela entrega a lista nova e segue; a mais nova de cada conversa
 * vence e é gravada em segundo plano, com nova tentativa quando o banco cai. O
 * que não drena em 3 s (e o que sobra no fechamento) vai para o diário local e
 * volta na abertura — mensagem enfileirada na queda não se perde.
 */
export class OutboxWriteQueue {
  private readonly entries = new Map<string, Entry>()
  private journalTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(private readonly deps: OutboxQueueDeps) {}

  replace(conversationId: string, items: Items): void {
    const entry = this.entry(conversationId)
    entry.items = items
    entry.version += 1
    if (entry.writtenVersion === entry.version - 1) entry.since = Date.now()
    this.schedule(conversationId, entry, COALESCE_MS)
  }

  /** A leitura vê o pendente: a fila de uma conversa ainda não gravada vem da memória. */
  overlay(stored: ReadonlyArray<{ conversationId: string; id: string; payload: unknown }>): Array<{ conversationId: string; id: string; payload: unknown }> {
    const pending = [...this.entries].filter(([, entry]) => entry.version > entry.writtenVersion || entry.writing)
    const pendingIds = new Set(pending.map(([id]) => id))
    return [
      ...stored.filter((item) => !pendingIds.has(item.conversationId)),
      ...pending.flatMap(([conversationId, entry]) => entry.items.map((item) => ({ conversationId, id: item.id, payload: item.payload })))
    ]
  }

  /** Abertura: o diário da sessão anterior volta como pendente (antes da tela ler a fila). */
  async restoreJournal(): Promise<number> {
    const saved = await this.deps.journal.loadAll()
    for (const item of saved) {
      const items = (item.doc as { items?: unknown } | null)?.items
      if (!Array.isArray(items)) continue
      const entry = this.entry(item.id)
      if (entry.version > entry.writtenVersion) continue
      entry.items = items as Items
      entry.version += 1
      entry.journaledVersion = entry.version
      entry.since = item.since
      this.schedule(item.id, entry, 0)
    }
    return saved.length
  }

  kick(): void {
    for (const [id, entry] of this.entries) {
      if (entry.version <= entry.writtenVersion || entry.writing) continue
      entry.failures = 0
      entry.retryAt = 0
      this.schedule(id, entry, 0)
    }
  }

  /** Grava já, esperando no máximo `deadlineMs`. `true` = tudo no banco. */
  async flush(deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      const waiting = [...this.entries].filter(([, entry]) => entry.version > entry.writtenVersion || entry.writing)
      if (!waiting.length) return true
      if (Date.now() >= deadline || !this.deps.repository()) return false
      for (const [id, entry] of waiting) if (!entry.writing) void this.run(id, entry)
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        Promise.all(waiting.map(([, entry]) => entry.writing ?? Promise.resolve())),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))))
      ])
      if (timer) clearTimeout(timer)
      if (waiting.some(([, entry]) => !entry.writing && entry.retryAt > Date.now())) return false
    }
  }

  /** Fechamento: o que não está no banco vai para o diário. */
  async journalPending(): Promise<number> {
    const waiting = [...this.entries].filter(([, entry]) => entry.version > entry.writtenVersion)
    await Promise.all(waiting.map(([id, entry]) => this.journal(id, entry)))
    return waiting.length
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.entries.values()) if (entry.timer) clearTimeout(entry.timer)
    if (this.journalTimer) clearInterval(this.journalTimer)
  }

  private entry(id: string): Entry {
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { items: [], version: 0, writtenVersion: 0, journaledVersion: 0, since: Date.now(), failures: 0, retryAt: 0, writing: null, timer: null }
      this.entries.set(id, entry)
    }
    return entry
  }

  private schedule(id: string, entry: Entry, delay: number): void {
    if (this.disposed || entry.writing || entry.version <= entry.writtenVersion) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.run(id, entry)
    }, Math.max(delay, entry.retryAt - Date.now(), 0))
    entry.timer.unref?.()
    this.ensureJournalTimer()
  }

  private run(id: string, entry: Entry): Promise<void> {
    if (entry.writing) return entry.writing
    const work = this.write(id, entry).finally(() => {
      entry.writing = null
      this.schedule(id, entry, 0)
    })
    entry.writing = work
    return work
  }

  private async write(id: string, entry: Entry): Promise<void> {
    const version = entry.version
    const repository = this.deps.repository()
    if (!repository) {
      entry.failures += 1
      entry.retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(entry.failures - 1, RETRY_DELAYS_MS.length - 1)]
      return
    }
    try {
      await repository.replaceConversationOutbox(id, entry.items)
      entry.failures = 0
      entry.retryAt = 0
      entry.writtenVersion = Math.max(entry.writtenVersion, version)
      if (entry.writtenVersion >= entry.version && entry.journaledVersion) {
        entry.journaledVersion = 0
        void this.deps.journal.remove(id).catch(() => undefined)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!retryable(error)) {
        // Recusa definitiva (fila torta): não fica tentando; a próxima mudança tenta de novo.
        entry.writtenVersion = version
        this.deps.log?.(`[fila de espera] ${id}: gravação recusada (${message})`)
        return
      }
      entry.failures += 1
      entry.retryAt = Date.now() + RETRY_DELAYS_MS[Math.min(entry.failures - 1, RETRY_DELAYS_MS.length - 1)]
      this.deps.log?.(`[fila de espera] ${id}: banco indisponível, nova tentativa (${message})`)
    }
  }

  private ensureJournalTimer(): void {
    if (this.journalTimer || this.disposed) return
    this.journalTimer = setInterval(() => {
      let waiting = false
      for (const [id, entry] of this.entries) {
        if (entry.version <= entry.writtenVersion) continue
        waiting = true
        if (Date.now() - entry.since >= JOURNAL_AFTER_MS && entry.journaledVersion < entry.version) void this.journal(id, entry)
      }
      if (!waiting && this.journalTimer) {
        clearInterval(this.journalTimer)
        this.journalTimer = null
      }
    }, 1_000)
    this.journalTimer.unref?.()
  }

  private async journal(id: string, entry: Entry): Promise<void> {
    const version = entry.version
    if (entry.journaledVersion >= version) return
    try {
      await this.deps.journal.save({ id, deleted: false, doc: { id, items: entry.items as unknown[] }, since: entry.since })
      entry.journaledVersion = Math.max(entry.journaledVersion, version)
      if (entry.writtenVersion >= entry.version) void this.deps.journal.remove(id).catch(() => undefined)
    } catch (error) {
      this.deps.log?.(`[fila de espera] diário de ${id} falhou: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
