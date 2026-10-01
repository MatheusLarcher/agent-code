/**
 * Efeito de digitação da tela do monitor. Os subagentes não fazem streaming
 * (a medição da fase 2 mostrou), então a tela revela o conteúdo REAL em 1 a
 * 2 s. Puro e com relógio injetável: o teste controla o tempo.
 */

export const TYPE_MIN_MS = 1000
export const TYPE_MAX_MS = 2000

/** Duração da digitação: textos curtos em 1 s, longos no máximo em 2 s. */
export function typingDuration(length: number): number {
  return Math.min(TYPE_MAX_MS, TYPE_MIN_MS + Math.max(0, length) / 2)
}

/** Fração já revelada (0–1) no instante `now`. */
export function revealFraction(startedAt: number, now: number, durationMs: number): number {
  if (durationMs <= 0) return 1
  return Math.max(0, Math.min(1, (now - startedAt) / durationMs))
}

/** Corta o texto na fração revelada. */
export function revealText(text: string, fraction: number): string {
  if (fraction >= 1) return text
  return text.slice(0, Math.floor(text.length * Math.max(0, fraction)))
}
