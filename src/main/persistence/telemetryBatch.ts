import type { LlmCall, TurnTimeInsert } from './types'

/**
 * Telemetria gravada em lote pela fila do main (writeQueue/telemetryQueue.ts):
 * uma transação a cada poucos segundos, em vez de duas por chamada de LLM. Os
 * totais (`llm_usage_totals`) chegam já SOMADOS em memória — um UPSERT por chave
 * por lote, e não um por chamada disputando a mesma linha (a "linha quente" do
 * log de 07/10).
 */

/** Uma linha de `llm_calls` completa (o `createdAt` é o da chamada, não o do lote). */
export type LlmCallWrite = LlmCall

/** O uso novo de uma chamada já gravada num lote anterior. */
export interface LlmCallUsagePatch {
  id: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | null
}

/** Somas a aplicar numa linha de `llm_usage_totals`. `subagentType` '' = raiz. */
export interface UsageTotalsDelta {
  convId: string
  day: string
  model: string
  subagentType: string
  sumInput: number
  sumOutput: number
  sumCacheRead: number
  sumCacheWrite: number
  /** `null` = nenhuma chamada do lote trouxe custo (o total guardado não muda). */
  sumCost: number | null
  callCount: number
}

export interface TurnTimeWrite extends TurnTimeInsert {
  id: string
  createdAt: string
}

export interface TelemetryBatch {
  calls: LlmCallWrite[]
  updates: LlmCallUsagePatch[]
  totals: UsageTotalsDelta[]
  turnTimes: TurnTimeWrite[]
}

export interface TelemetryBatchRepository {
  /** Grava o lote numa escrita só (PostgreSQL: uma transação). */
  writeTelemetryBatch(batch: TelemetryBatch): Promise<void>
}

export function totalsKey(delta: Pick<UsageTotalsDelta, 'convId' | 'day' | 'model' | 'subagentType'>): string {
  return [delta.convId, delta.day, delta.model, delta.subagentType].join('\u0000')
}

/** Soma `add` em `into` (custo: `null` só enquanto ninguém trouxe custo). */
export function addTotals(into: UsageTotalsDelta, add: Omit<UsageTotalsDelta, 'convId' | 'day' | 'model' | 'subagentType'>): void {
  into.sumInput += add.sumInput
  into.sumOutput += add.sumOutput
  into.sumCacheRead += add.sumCacheRead
  into.sumCacheWrite += add.sumCacheWrite
  into.sumCost = add.sumCost === null ? into.sumCost : (into.sumCost ?? 0) + add.sumCost
  into.callCount += add.callCount
}

export function isEmptyBatch(batch: TelemetryBatch): boolean {
  return !batch.calls.length && !batch.updates.length && !batch.totals.length && !batch.turnTimes.length
}
