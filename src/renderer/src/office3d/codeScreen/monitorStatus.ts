/**
 * O estado do Agent que a barra de tarefas mostra (menu do Agent, bandeja,
 * prévia) — PURO, lido da conversa como o App a guarda.
 *
 *   sessionModel(conv)    o modelo com que a sessão subiu (o evento `system` mais
 *                         recente); sem ele, o escolhido (o concreto do
 *                         Automático); nunca o sentinela
 *   sessionEffort(conv)   o esforço da sessão, idem
 *   lastResult(msgs)      o fim do turno mais recente: duração, custo, tokens
 *   turnElapsed(...)      quanto o turno levou (ou leva, trabalhando)
 */
import { contextLimitFor, isAutoEffort, isAutoModel } from '@shared/ipc'
import { EFFORT_LABELS } from '../../effortOptions'
import type { Conversation, UIMessage } from '../../types'

export function sessionModel(conv: Pick<Conversation, 'model' | 'autoModel' | 'messages'> | undefined): string {
  if (!conv) return ''
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]
    if (m.kind === 'system' && m.model && !isAutoModel(m.model)) return m.model
  }
  if (isAutoModel(conv.model)) return conv.autoModel && !isAutoModel(conv.autoModel) ? conv.autoModel : ''
  return conv.model ?? ''
}

export function sessionEffort(conv: Pick<Conversation, 'effort' | 'autoEffort' | 'messages'> | undefined): string {
  if (!conv) return ''
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i]
    if (m.kind === 'system') return m.effort ? (EFFORT_LABELS[m.effort] ?? m.effort) : ''
  }
  const effort = isAutoEffort(conv.effort) ? conv.autoEffort : conv.effort
  return effort ? (EFFORT_LABELS[effort] ?? effort) : ''
}

export interface TurnResult {
  durationMs: number
  costUsd: number | null
  outputTokens: number | null
}

/** O `result` do turno mais recente (null: o turno não fechou ainda ou não há). */
export function lastResult(msgs: readonly UIMessage[]): TurnResult | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.kind === 'user') return null
    if (m.kind === 'result') {
      return { durationMs: m.durationMs, costUsd: typeof m.costUsd === 'number' ? m.costUsd : null, outputTokens: m.usage ? m.usage.output : null }
    }
  }
  return null
}

/** Segundos do turno: trabalhando, desde `since`; parado, a duração do último `result`. */
export function turnElapsed(busy: boolean, since: number | undefined, result: TurnResult | null, now: number): number | null {
  if (busy && since) return Math.max(0, Math.round((now - since) / 1000))
  return result ? Math.round(result.durationMs / 1000) : null
}

export function fmtElapsed(s: number | null): string {
  if (s === null) return '—'
  const m = Math.floor(s / 60)
  return m > 0 ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`
}

export function clock(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function fmtUsd(v: number | null): string {
  return v === null ? '—' : `US$ ${v.toFixed(2).replace('.', ',')}`
}

/** O contexto ocupado (o da última resposta) sobre a janela do modelo da sessão. */
export function contextUse(conv: Pick<Conversation, 'tokens' | 'model' | 'autoModel' | 'messages'> | undefined): { used: number; max: number; pct: number } {
  const used = conv?.tokens?.context ?? 0
  const max = contextLimitFor(sessionModel(conv) || undefined)
  return { used, max, pct: max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0 }
}
