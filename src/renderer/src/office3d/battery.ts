/**
 * Baterias do escritório 3D, em funções puras: nível/cor a partir da carga
 * restante, a carga do contexto de um agente e a bateria da SESSÃO 5h da conta
 * (mesma janela `five_hour` que o cabeçalho mostra como "Sessão 5h").
 */
import type { RateLimitStatus } from '@shared/ipc'

export type BatteryLevel = 'high' | 'mid' | 'low'

export interface BatteryState {
  /** Carga restante, 0..1. */
  charge: number
  level: BatteryLevel
  /** Cor CSS/hex do nível. */
  color: string
}

export const BATTERY_COLORS: Record<BatteryLevel, string> = {
  high: '#3ccf6e',
  mid: '#f2c230',
  low: '#ff4d4d'
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** Verde acima de 50%, amarelo acima de 20%, vermelho no resto. */
export function batteryLevel(charge: number): BatteryState {
  const c = clamp01(charge)
  const level: BatteryLevel = c > 0.5 ? 'high' : c > 0.2 ? 'mid' : 'low'
  return { charge: c, level, color: BATTERY_COLORS[level] }
}

/** Contexto restante da conversa (tokens.context / contextLimitFor(model)); null sem dado. */
export function contextBattery(context: { tokens: number; max: number } | undefined): BatteryState | null {
  if (!context || !(context.max > 0) || !(context.tokens >= 0)) return null
  return batteryLevel(1 - context.tokens / context.max)
}

/** "reseta em 2h 05min" / "reseta em 12min"; vazio se não houver horário ou já passou. */
export function formatResetIn(resetsAt: number | undefined, now: number): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return ''
  const mins = Math.ceil((resetsAt - now) / 60_000)
  if (mins <= 0) return ''
  if (mins < 60) return `reseta em ${mins}min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `reseta em ${h}h ${String(m).padStart(2, '0')}min` : `reseta em ${h}h`
}

export interface SessionBattery extends BatteryState {
  /** Porcentagem restante (0..100, inteira). */
  percent: number
  /** Porcentagem usada, como no cabeçalho. */
  usedPercent: number
  resetText: string
  rejected: boolean
}

/** Bateria da janela de 5h da conta; null sem dado (o HUD some). */
export function sessionBattery(limits: Readonly<Record<string, RateLimitStatus>> | undefined, now: number): SessionBattery | null {
  const l = limits?.five_hour
  if (!l) return null
  const rejected = l.status === 'rejected'
  if (l.utilization === undefined && !rejected) return null
  const used = rejected ? 1 : clamp01(l.utilization ?? 0)
  const state = batteryLevel(1 - used)
  return {
    ...state,
    percent: Math.round(state.charge * 100),
    usedPercent: Math.round(used * 100),
    resetText: formatResetIn(l.resetsAt, now),
    rejected
  }
}
