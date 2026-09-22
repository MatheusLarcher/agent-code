/** Provider-neutral context order. Routing and protocol adapters must never
 * choose different user instructions, documentation, memory or skill catalogs. */
export interface PromptContext {
  stamp: string
  /** Change-only catalog updates that are intentionally part of history. */
  memory: string
  skills: string
  /** Change-only list of projects known on this machine — same "only when it
   *  changes" rule as memory/skills, so it lands in history once, not every turn. */
  projects: string
  reminder: string
}

export interface RequestContext {
  docs: string
  /** Bounded relevant excerpts only; never the complete memory index. */
  memory: string
}

/**
 * The persisted user turn deliberately contains no full project-documents
 * block. It stays readable on resume and avoids copying tens of thousands of
 * tokens into every stored user message. Live request context travels through
 * Agent SDK hooks instead (composeRequestContext).
 */
export function composeUserPrompt(body: string, parts: PromptContext): string {
  const context = [parts.stamp, parts.memory, parts.skills, parts.projects, parts.reminder]
    .filter(Boolean)
    .join('\n\n')
  const loopMatch = body.match(/^\s*\/loop(?:\s+|$)/iu)
  if (loopMatch) {
    const task = body.slice(loopMatch[0].length)
    return task ? `/loop ${context}\n\n${task}` : `/loop ${context}`
  }
  return body ? `${context}\n\n${body}` : context
}

/** Context injected just before an actual provider request, rather than stored
 * as user text. Keep docs first: every provider sees the same authoritative
 * project view before its relevant-memory excerpts. */
export function composeRequestContext(parts: RequestContext): string {
  return [parts.docs, parts.memory].filter(Boolean).join('\n\n')
}
