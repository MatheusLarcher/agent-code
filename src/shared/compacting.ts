/**
 * A compactação ao vivo, lida da mensagem `system/status` do SDK. O probe live
 * (claude-haiku-5-5, `/compact`) mostrou a sequência:
 *   status {status:'compacting'} → status {status:null, compact_result:'success'}
 *   → init → compact_boundary → result.
 * O fim chega ANTES do `compact_boundary`; uma falha vem com
 * `compact_result: 'failed'` e `compact_error`. Outros status (`'requesting'`)
 * não dizem nada sobre a compactação.
 */
export type CompactStatus = { phase: 'start' } | { phase: 'end'; failed: boolean; error?: string }

/** `null` quando a mensagem não é `system/status` ou não fala de compactação. */
export function readCompactStatus(message: unknown): CompactStatus | null {
  if (!message || typeof message !== 'object') return null
  const m = message as Record<string, unknown>
  if (m.type !== 'system' || m.subtype !== 'status') return null
  if (m.status === 'compacting') return { phase: 'start' }
  const result = m.compact_result
  if (m.status !== null && result === undefined) return null
  const failed = result === 'failed'
  const error = failed && typeof m.compact_error === 'string' ? m.compact_error.slice(0, 300) : undefined
  return error ? { phase: 'end', failed, error } : { phase: 'end', failed }
}

/** O texto da linha viva enquanto o CLI compacta (todos os chats, PC e celular). */
export const COMPACTING_LABEL = 'Compactando a conversa…'

/** A nota quando a compactação falha (o turno segue com o contexto inteiro). */
export function compactFailedText(error?: string): string {
  return `A compactação falhou${error ? `: ${error}` : ''}. A conversa segue sem compactar.`
}
