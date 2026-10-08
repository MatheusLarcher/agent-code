import type { ContextTurnDetail, ContextTurnSummary } from '../../../shared/contextSnapshot'
import { isTransientPostgresError } from '../postgresRetry'
import { StorageError, type ContextHistoryRepository, type ContextTurnWrite } from '../types'

/** As gravações de um turno em ~1 s viram uma só (a mais nova). */
const FLUSH_MS = 1_000
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** Sem banco por muito tempo: os turnos mais velhos saem da fila. */
const MAX_PENDING_TURNS = 200

export interface ContextHistoryQueueDeps {
  /** Quem grava; `null` sem banco gravável (a fila espera). */
  repository(): ContextHistoryRepository | null
  /** Quem lê e apaga (na hora, como antes). */
  reader(): ContextHistoryRepository
  log?(line: string): void
}

const keyOf = (write: Pick<ContextTurnWrite, 'convId' | 'turnId'>): string => `${write.convId}\u0000${write.turnId}`

function retryable(error: unknown): boolean {
  return error instanceof StorageError ? error.retryable : isTransientPostgresError(error)
}

/**
 * O histórico do contexto entregue ao agente pela fila do main. A captura grava o
 * turno inteiro várias vezes (envio, início, cada lote de ferramentas, fim): aqui
 * as gravações do MESMO turno que chegam juntas viram uma — só a mais nova vai —,
 * uma de cada vez, em segundo plano. Quem grava nunca espera o banco.
 */
export class ContextHistoryQueue implements ContextHistoryRepository {
  private readonly pending = new Map<string, ContextTurnWrite>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<boolean> | null = null
  private failures = 0
  private disposed = false

  constructor(private readonly deps: ContextHistoryQueueDeps) {}

  async saveContextTurn(write: ContextTurnWrite): Promise<void> {
    const key = keyOf(write)
    this.pending.delete(key)
    this.pending.set(key, write)
    if (this.pending.size > MAX_PENDING_TURNS) {
      const oldest = this.pending.keys().next().value as string
      this.pending.delete(oldest)
      this.deps.log?.('[contexto] banco indisponível há muito tempo: o turno mais velho da fila foi descartado')
    }
    this.schedule()
  }

  listContextTurns(convId: string, limit: number): Promise<ContextTurnSummary[]> {
    return this.deps.reader().listContextTurns(convId, limit)
  }

  readContextTurn(convId: string, turnId: string): Promise<ContextTurnDetail | null> {
    return this.deps.reader().readContextTurn(convId, turnId)
  }

  /** Apagar a conversa leva junto o que ainda nem foi gravado dela. */
  deleteContextTurns(convId: string): Promise<number> {
    for (const [key, write] of this.pending) if (write.convId === convId) this.pending.delete(key)
    return this.deps.reader().deleteContextTurns(convId)
  }

  pruneOrphanContextBlobs(): Promise<number> {
    return this.deps.reader().pruneOrphanContextBlobs()
  }

  /** Grava já o que está na fila, esperando no máximo `deadlineMs`. `true` = vazia. */
  async flush(deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      if (!this.pending.size && !this.writing) return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      const ok = await Promise.race([
        this.writing ?? this.drain(),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), remaining)))
      ])
      if (timer) clearTimeout(timer)
      if (!ok) return false
    }
  }

  /** O banco voltou: grava já, sem esperar o recuo. */
  kick(): void {
    this.failures = 0
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.pending.size) this.schedule(0)
  }

  pendingCount(): number {
    return this.pending.size
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(delay = FLUSH_MS): void {
    if (this.disposed || this.timer || this.writing) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drain()
    }, delay)
    this.timer.unref?.()
  }

  /** Grava a fila, um turno por vez. `false` = parou numa falha (fica para depois). */
  private drain(): Promise<boolean> {
    if (this.writing) return this.writing
    const run = (async (): Promise<boolean> => {
      for (;;) {
        const next = this.pending.entries().next()
        if (next.done) return true
        const [key, write] = next.value
        const repository = this.deps.repository()
        if (!repository) {
          this.failures += 1
          return false
        }
        this.pending.delete(key)
        try {
          await repository.saveContextTurn(write)
          this.failures = 0
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!retryable(error)) {
            this.deps.log?.(`[contexto] turno ${write.turnId} recusado e descartado: ${message}`)
            continue
          }
          // Uma gravação mais nova do mesmo turno, chegada durante a tentativa, vence.
          if (!this.pending.has(key)) {
            const rest = [...this.pending]
            this.pending.clear()
            this.pending.set(key, write)
            for (const [restKey, restWrite] of rest) this.pending.set(restKey, restWrite)
          }
          this.failures += 1
          this.deps.log?.(`[contexto] banco indisponível, nova tentativa (${message})`)
          return false
        }
      }
    })()
    this.writing = run
    void run.finally(() => {
      this.writing = null
      if (!this.pending.size) return
      const delay = this.failures ? RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)] : FLUSH_MS
      this.schedule(delay)
    })
    return run
  }
}
