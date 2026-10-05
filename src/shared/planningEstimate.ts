/**
 * Regra ÚNICA da estimativa de uma etapa do roteiro: minutos de trabalho do
 * AGENTE de implementação (não de um desenvolvedor humano), inteiro de 1 a
 * MAX_ESTIMATIVA_MIN. Usada pelo main (planningModel, ferramentas plan_*, IPC)
 * e pelo renderer, para os dois lados nunca discordarem.
 */

export const MAX_ESTIMATIVA_MIN = 10_000

export function isValidEstimativa(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_ESTIMATIVA_MIN
}

/** Soma das estimativas válidas e quantas etapas ficaram sem nenhuma. */
export function sumEstimativas(etapas: readonly { estimativa?: number | null }[]): { total: number; semEstimativa: number } {
  let total = 0
  let semEstimativa = 0
  for (const e of etapas) {
    if (isValidEstimativa(e.estimativa)) total += e.estimativa
    else semEstimativa++
  }
  return { total, semEstimativa }
}

/** "45 min", "2 h" ou "1 h 30 min". */
export function formatMinutos(minutos: number): string {
  const n = Math.max(0, Math.round(minutos))
  if (n < 60) return `${n} min`
  const h = Math.floor(n / 60)
  const m = n % 60
  return m ? `${h} h ${m} min` : `${h} h`
}
