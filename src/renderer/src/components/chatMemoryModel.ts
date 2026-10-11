import type { UIMessage } from '../types'
import { usageFromMessages } from '../office3d/memoryUsage'

export interface ChatMemoryEntry { relPath: string; supplied: boolean; read: boolean }

// Apenas nomes de arquivos relativos de memória; conteúdo e cofre nunca entram.
function memoryName(value: string): string | null {
  const path = value.replace(/\\/g, '/')
  if (!path || path.length > 4096 || /[\u0000-\u001f:]/.test(path) || path.startsWith('/') || !/\.md$/i.test(path)) return null
  if (path.split('/').some((s) => !s || s === '.' || s === '..') || path.toLowerCase() === 'memory.md') return null
  return path
}

/** Mesmas fontes do escritório: snapshot enviado e Read bem-sucedido no histórico. */
export function chatMemoryEntries(messages: readonly UIMessage[], sent: readonly string[], dir: string | null): ChatMemoryEntry[] {
  const found = new Map<string, ChatMemoryEntry>()
  const add = (name: string, source: 'supplied' | 'read'): void => {
    const relPath = memoryName(name)
    if (!relPath) return
    const key = dir && /^[a-z]:/i.test(dir) ? relPath.toLowerCase() : relPath
    const entry = found.get(key) ?? { relPath, supplied: false, read: false }
    entry[source] = true
    found.set(key, entry)
  }
  sent.forEach((name) => add(name, 'supplied'))
  const events = usageFromMessages({ id: '', title: '', cwd: '', updatedAt: 0, messages: [...messages] }, dir)
  for (const e of events) if (e.how === 'lida' && e.relPath) add(e.relPath, 'read')
  return [...found.values()]
}

export interface MemoryTurnRequest { userId: string; turnIds: string[] }
export interface MemoryTurnSegment extends MemoryTurnRequest { messages: UIMessage[] }

function identities(m: UIMessage): string[] {
  const value = m as { turnIds?: unknown; sdkUuid?: unknown }
  return [...new Set([...(Array.isArray(value.turnIds) ? value.turnIds : []), value.sdkUuid]
    .filter((id): id is string => typeof id === 'string' && !!id))]
}

/** Segmentação linear; identidade persistida vence posição de um evento tardio. */
export function memoryTurnSegments(messages: readonly UIMessage[]): MemoryTurnSegment[] {
  const requests: MemoryTurnSegment[] = []
  const users = new Map<string, MemoryTurnSegment>()
  const owners = new Map<string, MemoryTurnSegment>()
  const add = (owner: MemoryTurnSegment, id: string): void => {
    if (owners.has(id)) return
    owners.set(id, owner)
    owner.turnIds.push(id)
  }
  // Bolhas persistidas já identificam snapshots antes de qualquer resposta.
  for (const m of messages) if (m.kind === 'user' && !m.injected) {
    const r = { userId: m.id, turnIds: [], messages: [] } as MemoryTurnSegment
    requests.push(r)
    users.set(m.id, r)
    identities(m).forEach((id) => add(r, id))
  }
  let current: MemoryTurnSegment | undefined
  for (const m of messages) {
    if (m.kind === 'user' && !m.injected) current = users.get(m.id)
    const ids = identities(m)
    const known = [...new Set(ids.flatMap((id) => owners.has(id) ? [owners.get(id)!] : []))]
    const targets = known.length ? known : current ? [current] : []
    // Alias de continuação só quando há dono inequívoco; nunca rouba id conhecido.
    if (targets.length === 1) ids.forEach((id) => add(targets[0], id))
    targets.forEach((r) => r.messages.push(m))
  }
  return requests
}

export function turnMemoryRequests(messages: readonly UIMessage[]): MemoryTurnRequest[] {
  return memoryTurnSegments(messages).map(({ userId, turnIds }) => ({ userId, turnIds }))
}

export function messagesForMemoryTurn(messages: readonly UIMessage[], userId: string): readonly UIMessage[] {
  return memoryTurnSegments(messages).find((r) => r.userId === userId)?.messages ?? []
}
