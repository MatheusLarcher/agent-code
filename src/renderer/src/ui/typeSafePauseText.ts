import type { TypeSafePauseStatus } from '@shared/typesafePause'

/** "Roteamento IA pausado até 17:10 — key recusada", ou null sem pausa. */
export function typeSafePauseText(status: TypeSafePauseStatus | null, now = Date.now()): string | null {
  if (!status?.pausedUntil || status.pausedUntil <= now) return null
  const hora = new Date(status.pausedUntil).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return `Roteamento IA pausado até ${hora}${status.reason ? ` — ${status.reason}` : ''}`
}
