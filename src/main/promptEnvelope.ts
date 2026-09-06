/** Provider-neutral context order. Routing and protocol adapters must never
 * choose different user instructions, documentation, memory or skill catalogs. */
export interface PromptContext {
  stamp: string
  docs: string
  memory: string
  skills: string
  reminder: string
}

export function composeUserPrompt(body: string, parts: PromptContext): string {
  const context = [parts.stamp, parts.docs, parts.memory, parts.skills, parts.reminder].filter(Boolean).join('\n\n')
  const loopMatch = body.match(/^\s*\/loop(?:\s+|$)/iu)
  if (loopMatch) {
    const task = body.slice(loopMatch[0].length)
    return task ? `/loop ${context}\n\n${task}` : `/loop ${context}`
  }
  return body ? `${context}\n\n${body}` : context
}
