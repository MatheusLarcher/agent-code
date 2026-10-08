import { randomUUID } from 'node:crypto'
import type { TurnTimeTotals } from '../../../shared/ipc'
import { isTransientPostgresError } from '../postgresRetry'
import {
  addTotals,
  isEmptyBatch,
  totalsKey,
  type LlmCallUsagePatch,
  type LlmCallWrite,
  type TelemetryBatch,
  type TurnTimeWrite,
  type UsageTotalsDelta
} from '../telemetryBatch'
import {
  StorageError,
  type LlmCall,
  type LlmCallInsert,
  type LlmCallUsageUpdate,
  type LlmUsageTotal,
  type PersistenceRepository,
  type TokenUsageRepository,
  type TurnTimeInsert
} from '../types'

/** Lote a cada poucos segundos: a telemetria nunca disputa o banco a cada chamada. */
const FLUSH_MS = 3_000
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
/** Sem banco por muito tempo: o detalhe mais velho sai (os totais, pequenos, ficam). */
const MAX_PENDING_CALLS = 5_000
/** Base para a correção (`updateLlmCall`) das chamadas recentes deste processo. */
const MAX_KNOWN_CALLS = 2_000

type Repository = Pick<PersistenceRepository, 'writeTelemetryBatch'> & TokenUsageRepository

export interface TelemetryQueueDeps {
  /** Quem grava; `null` sem banco gravável (a fila espera). */
  repository(): Repository | null
  /** Quem lê (as leituras somam o que ainda está na fila). */
  reader(): TokenUsageRepository
  log?(line: string): void
  now?(): number
}

interface Known {
  call: LlmCallWrite
}

function retryable(error: unknown): boolean {
  return error instanceof StorageError ? error.retryable : isTransientPostgresError(error)
}

function usageOf(call: Pick<LlmCallWrite, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd'>) {
  return {
    sumInput: call.inputTokens,
    sumOutput: call.outputTokens,
    sumCacheRead: call.cacheReadTokens,
    sumCacheWrite: call.cacheWriteTokens,
    sumCost: call.costUsd
  }
}

/**
 * A telemetria das sessões (`llm_calls`, `llm_usage_totals`, tempo de turno) pela
 * fila do main: quem grava recebe a resposta na hora e o banco recebe um lote a
 * cada ~3 s — INSERT de várias linhas, correções em lote e UM upsert por chave
 * de total, com as somas feitas aqui em memória. As leituras somam o que ainda
 * está na fila, para a tela não ver número velho.
 */
export class TelemetryQueue implements TokenUsageRepository {
  private calls = new Map<string, LlmCallWrite>()
  private patches = new Map<string, LlmCallUsagePatch>()
  private totals = new Map<string, UsageTotalsDelta>()
  private turnTimes: TurnTimeWrite[] = []
  private readonly known = new Map<string, Known>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<boolean> | null = null
  private failures = 0
  private disposed = false

  constructor(private readonly deps: TelemetryQueueDeps) {}

  async insertLlmCall(input: LlmCallInsert): Promise<LlmCall> {
    const call: LlmCallWrite = {
      id: input.id ?? randomUUID(),
      convId: input.convId,
      turnId: input.turnId,
      nodeId: input.nodeId,
      parentNodeId: input.parentNodeId ?? null,
      subagentType: input.subagentType ?? null,
      taskDescription: input.taskDescription ?? null,
      seq: input.seq,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      costUsd: input.costUsd ?? null,
      inputPreview: input.inputPreview ?? null,
      outputPreview: input.outputPreview ?? null,
      createdAt: new Date(this.now()).toISOString()
    }
    this.calls.set(call.id, call)
    this.remember(call)
    this.addTo(call, { ...usageOf(call), callCount: 1 })
    this.trimPending()
    this.schedule()
    return { ...call }
  }

  async updateLlmCall(id: string, usage: LlmCallUsageUpdate): Promise<LlmCall | null> {
    const base = this.known.get(id)?.call
    // Chamada de outro processo (ou já esquecida): a correção vai direto, como antes.
    if (!base) return (await this.deps.repository()?.updateLlmCall(id, usage)) ?? null
    const next: LlmCallWrite = {
      ...base,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      costUsd: usage.costUsd === undefined ? base.costUsd : usage.costUsd
    }
    this.addTo(next, {
      sumInput: next.inputTokens - base.inputTokens,
      sumOutput: next.outputTokens - base.outputTokens,
      sumCacheRead: next.cacheReadTokens - base.cacheReadTokens,
      sumCacheWrite: next.cacheWriteTokens - base.cacheWriteTokens,
      sumCost: base.costUsd === null || next.costUsd === null ? null : next.costUsd - base.costUsd,
      callCount: 0
    })
    this.remember(next)
    if (this.calls.has(id)) this.calls.set(id, next)
    else {
      const { id: _id, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd } = next
      this.patches.set(id, { id, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd })
    }
    this.schedule()
    return { ...next }
  }

  async insertTurnTime(input: TurnTimeInsert): Promise<void> {
    this.turnTimes.push({ ...input, id: randomUUID(), createdAt: new Date(this.now()).toISOString() })
    this.schedule()
  }

  async listLlmCalls(convId: string): Promise<LlmCall[]> {
    const stored = (await this.deps.reader().listLlmCalls(convId)).map((call) => {
      const patch = this.patches.get(call.id)
      return patch ? { ...call, ...patch } : call
    })
    const seen = new Set(stored.map((call) => call.id))
    const pending = [...this.calls.values()].filter((call) => call.convId === convId && !seen.has(call.id))
    return [...stored, ...pending.map((call) => ({ ...call }))].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq
    )
  }

  async listLlmUsageTotals(convId: string): Promise<LlmUsageTotal[]> {
    const merged = new Map<string, LlmUsageTotal>()
    for (const total of await this.deps.reader().listLlmUsageTotals(convId)) {
      merged.set(totalsKey({ ...total, subagentType: total.subagentType ?? '' }), { ...total })
    }
    for (const [key, delta] of this.totals) {
      if (delta.convId !== convId) continue
      const current = merged.get(key) ?? {
        convId, day: delta.day, model: delta.model, subagentType: delta.subagentType || null,
        sumInput: 0, sumOutput: 0, sumCacheRead: 0, sumCacheWrite: 0, sumCost: null, callCount: 0
      }
      const shape = { ...current, subagentType: delta.subagentType }
      addTotals(shape, delta)
      merged.set(key, { ...shape, subagentType: shape.subagentType || null })
    }
    return [...merged.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model) || (a.subagentType ?? '').localeCompare(b.subagentType ?? ''))
  }

  async turnTimeTotals(convId: string): Promise<TurnTimeTotals> {
    const stored = await this.deps.reader().turnTimeTotals(convId)
    const pending = this.turnTimes.filter((turn) => turn.convId === convId)
    if (!pending.length) return stored
    const added = pending.reduce((sum, turn) => sum + Math.max(0, Math.round(turn.durationMs)), 0)
    return {
      totalMs: stored.totalMs + added,
      turns: stored.turns + pending.length,
      lastMs: Math.max(0, Math.round(pending[pending.length - 1].durationMs))
    }
  }

  /** Grava já o que está na fila, esperando no máximo `deadlineMs`. `true` = vazia. */
  async flush(deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs
    for (;;) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      if (!this.hasPending() && !this.writing) return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let timer: ReturnType<typeof setTimeout> | undefined
      const ok = await Promise.race([
        this.writing ?? this.write(),
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
    if (this.hasPending()) this.schedule(0)
  }

  /** O que está na fila agora (números do fechamento). */
  pendingCounts(): { calls: number; updates: number; totals: number; turnTimes: number } {
    return { calls: this.calls.size, updates: this.patches.size, totals: this.totals.size, turnTimes: this.turnTimes.length }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private remember(call: LlmCallWrite): void {
    this.known.delete(call.id)
    this.known.set(call.id, { call })
    if (this.known.size > MAX_KNOWN_CALLS) this.known.delete(this.known.keys().next().value as string)
  }

  private addTo(call: LlmCallWrite, add: Omit<UsageTotalsDelta, 'convId' | 'day' | 'model' | 'subagentType'>): void {
    const shape = { convId: call.convId, day: call.createdAt.slice(0, 10), model: call.model, subagentType: call.subagentType ?? '' }
    const key = totalsKey(shape)
    let delta = this.totals.get(key)
    if (!delta) {
      delta = { ...shape, sumInput: 0, sumOutput: 0, sumCacheRead: 0, sumCacheWrite: 0, sumCost: null, callCount: 0 }
      this.totals.set(key, delta)
    }
    addTotals(delta, add)
  }

  private hasPending(): boolean {
    return this.calls.size > 0 || this.patches.size > 0 || this.totals.size > 0 || this.turnTimes.length > 0
  }

  private trimPending(): void {
    if (this.calls.size <= MAX_PENDING_CALLS) return
    const drop = this.calls.size - MAX_PENDING_CALLS
    const ids = [...this.calls.keys()].slice(0, drop)
    for (const id of ids) this.calls.delete(id)
    this.deps.log?.(`[telemetria] banco indisponível há muito tempo: ${drop} chamada(s) antiga(s) descartada(s) (os totais ficam)`)
  }

  private schedule(delay = FLUSH_MS): void {
    if (this.disposed || this.timer || this.writing) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.write()
    }, delay)
    this.timer.unref?.()
  }

  /** Um lote: tira o que está na fila, grava; falhou, devolve para a próxima tentativa. */
  private write(): Promise<boolean> {
    if (this.writing) return this.writing
    const run = (async (): Promise<boolean> => {
      const repository = this.deps.repository()
      if (!repository) {
        this.failures += 1
        return false
      }
      const batch: TelemetryBatch = {
        calls: [...this.calls.values()],
        updates: [...this.patches.values()],
        totals: [...this.totals.values()],
        turnTimes: this.turnTimes
      }
      if (isEmptyBatch(batch)) return true
      this.calls = new Map()
      this.patches = new Map()
      this.totals = new Map()
      this.turnTimes = []
      try {
        await repository.writeTelemetryBatch(batch)
        this.failures = 0
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!retryable(error)) {
          this.deps.log?.(`[telemetria] lote recusado e descartado (${batch.calls.length} chamadas): ${message}`)
          return false
        }
        this.failures += 1
        this.restore(batch)
        this.deps.log?.(`[telemetria] banco indisponível, nova tentativa (${message})`)
        return false
      }
    })()
    this.writing = run
    void run.finally(() => {
      this.writing = null
      if (!this.hasPending()) return
      const delay = this.failures ? RETRY_DELAYS_MS[Math.min(this.failures - 1, RETRY_DELAYS_MS.length - 1)] : FLUSH_MS
      this.schedule(delay)
    })
    return run
  }

  /** Lote que não foi: volta para a fila, sem perder o que chegou enquanto ele tentava. */
  private restore(batch: TelemetryBatch): void {
    const calls = new Map(batch.calls.map((call) => [call.id, call]))
    for (const [id, call] of this.calls) calls.set(id, call)
    this.calls = calls
    for (const patch of batch.updates) if (!this.patches.has(patch.id)) this.patches.set(patch.id, patch)
    for (const delta of batch.totals) {
      const key = totalsKey(delta)
      const current = this.totals.get(key)
      if (current) addTotals(current, delta)
      else this.totals.set(key, { ...delta })
    }
    this.turnTimes = [...batch.turnTimes, ...this.turnTimes]
    this.trimPending()
  }
}
