/**
 * As memórias que uma resposta do agente GRAVOU (memory_propose com sucesso) — PURO.
 * Viram a linha discreta "Anotei na memória · título" embaixo da linha de passos
 * (MemorySavedNote). Só o nome e o título: o corpo nunca entra aqui.
 */

export type MemorySaveOp = 'create' | 'update' | 'retire'

export interface MemorySaved {
  op: MemorySaveOp
  relPath: string
  title: string
}

const OPS: ReadonlySet<string> = new Set(['create', 'update', 'retire'])
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function savedMemories(tools: readonly unknown[]): MemorySaved[] {
  const out = new Map<string, MemorySaved>()
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const m = t as { name?: unknown; input?: unknown; result?: { isError?: unknown } | null }
    if (m.name !== 'mcp__memory__memory_propose' || !m.result || m.result.isError) continue
    const o = m.input && typeof m.input === 'object' ? (m.input as Record<string, unknown>) : {}
    const op = OPS.has(str(o.op)) ? (str(o.op) as MemorySaveOp) : 'create'
    const relPath = str(o.rel_path).replace(/\\/g, '/').slice(0, 300)
    const title = str(o.title).slice(0, 160)
    // A mesma memória duas vezes na resposta: vale a última operação.
    const key = relPath || `#${out.size}`
    out.delete(key)
    out.set(key, { op, relPath, title })
  }
  return [...out.values()]
}

const VERB: Record<MemorySaveOp, string> = { create: 'Anotei na memória', update: 'Atualizei a memória', retire: 'Aposentei a memória' }

export function memorySavedVerb(op: MemorySaveOp): string {
  return VERB[op]
}

/** O nome mostrado: o título; sem ele, o arquivo sem pasta nem ".md". */
export function memorySavedLabel(m: MemorySaved): string {
  if (m.title) return m.title
  const file = m.relPath.split('/').pop() ?? ''
  return file.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim() || 'nova memória'
}
