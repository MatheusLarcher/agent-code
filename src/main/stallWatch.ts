// Detects when a running turn has gone quiet for too long — a signal that the
// system may be overloaded (too many concurrent agent sessions competing for
// CPU/network) and the model/tool call is stuck rather than just slow. Pure and
// framework-free so it can be unit-tested without real timers (see vad.ts for
// the same pattern applied to voice activity detection).

/** No activity for this long (ms), with NO tool currently in flight, counts as
 *  stalled. Tuned so normal LLM token latency never trips it, but a genuinely
 *  stuck turn is flagged reasonably fast. */
export const STALL_THRESHOLD_MS = 60_000

/** No activity for this long (ms) while a TOOL is in flight (e.g. a build or
 *  download) counts as stalled. Much longer than the plain threshold — legit
 *  tool calls can run for minutes without emitting anything.
 *
 *  Um bloco de raciocínio ABERTO do principal (`content_block_start` thinking
 *  sem `content_block_stop`) usa estes mesmos limiares (`toolInFlight` true em
 *  `stallVerdict`). Medido ao vivo com sonda contra a conta real (Sonnet 5.5 e
 *  Opus 5.5, `thinking: adaptive`, `display: 'summarized'`): todos os
 *  `thinking_delta` chegam em rajada só no FIM do bloco, então raciocínio
 *  legítimo passa minutos sem sinal nenhum — com o limiar de 60 s virava
 *  "Sem resposta há X" (33 avisos nos logs, 5 falhas reais). */
export const STALL_THRESHOLD_TOOL_MS = 5 * 60_000

/** How often the session re-checks. Well under the shortest threshold, so the
 *  banner flips within a few seconds of the turn actually going quiet, while
 *  costing one comparison per tick. */
export const STALL_POLL_MS = 5_000

/** Segundo limiar, sem ferramenta em voo: silêncio total por tanto tempo é
 *  travamento DEFINITIVO — o turno é encerrado (interrupt + `error` incomplete),
 *  não só avisado. Dez vezes o aviso: latência de token, thinking e as novas
 *  tentativas do CLI contra a API emitem sinal de vida muito antes disso. */
export const STALL_ABORT_MS = 10 * 60_000

/** Idem com ferramenta em voo. Acima do teto do Bash do CLI (10 min) com folga
 *  para build/download legítimos; subagente em primeiro plano emite mensagens
 *  (que contam como vida), então não chega perto disto trabalhando. */
export const STALL_ABORT_TOOL_MS = 30 * 60_000

/** Whether a turn that's been quiet since `lastActivityAt` should be flagged as
 *  stalled at time `now`, given whether a tool call is currently in flight. */
export function isStalled(now: number, lastActivityAt: number, toolInFlight: boolean): boolean {
  const threshold = toolInFlight ? STALL_THRESHOLD_TOOL_MS : STALL_THRESHOLD_MS
  return now - lastActivityAt > threshold
}

/** `ok` = sinal de vida recente; `warn` = só o aviso (`stall-status`); `abort` =
 *  travamento definitivo, o turno deve ser encerrado. `toolInFlight` = há
 *  trabalho longo legítimo em curso: ferramenta em voo OU bloco thinking aberto
 *  (ver STALL_THRESHOLD_TOOL_MS). */
export type StallVerdict = 'ok' | 'warn' | 'abort'

export function stallVerdict(now: number, lastActivityAt: number, toolInFlight: boolean): StallVerdict {
  const abortAfter = toolInFlight ? STALL_ABORT_TOOL_MS : STALL_ABORT_MS
  if (now - lastActivityAt > abortAfter) return 'abort'
  return isStalled(now, lastActivityAt, toolInFlight) ? 'warn' : 'ok'
}

/** Folga depois do horário da nova tentativa da API agendada pelo CLI: até lá o
 *  silêncio é a espera dele, não travamento. Igual ao limiar do aviso. */
export const API_RETRY_GRACE_MS = 60_000

/** O silêncio não conta — nem aviso nem abort: o app espera o usuário (permissão
 *  ou pergunta pendente) ou a nova tentativa da API (até `retryAt` + folga). */
export function stallSuppressed(input: { pendingPermissions: number; retryAt: number | null | undefined; now: number }): boolean {
  if (input.pendingPermissions > 0) return true
  return typeof input.retryAt === 'number' && input.now <= input.retryAt + API_RETRY_GRACE_MS
}

/** Texto do terminal do travamento definitivo (minutos inteiros, mínimo 1). */
export function stallAbortText(idleMs: number): string {
  const minutes = Math.max(1, Math.round(idleMs / 60_000))
  return `Sessão travada: sem resposta há ${minutes} min — retomando de onde parou.`
}
