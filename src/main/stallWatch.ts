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
 *  tool calls can run for minutes without emitting anything. */
export const STALL_THRESHOLD_TOOL_MS = 5 * 60_000

/** How often the session re-checks. Well under the shortest threshold, so the
 *  banner flips within a few seconds of the turn actually going quiet, while
 *  costing one comparison per tick. */
export const STALL_POLL_MS = 5_000

/** Whether a turn that's been quiet since `lastActivityAt` should be flagged as
 *  stalled at time `now`, given whether a tool call is currently in flight. */
export function isStalled(now: number, lastActivityAt: number, toolInFlight: boolean): boolean {
  const threshold = toolInFlight ? STALL_THRESHOLD_TOOL_MS : STALL_THRESHOLD_MS
  return now - lastActivityAt > threshold
}
