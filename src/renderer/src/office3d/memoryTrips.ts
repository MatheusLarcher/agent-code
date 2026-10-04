/**
 * A ida à estante de Memórias (req-arquivo-memorias) — PURO na decisão.
 *
 * Conta como consulta à memória, lida das ferramentas do turno:
 *   - mcp__memory__* (memory_propose é gravar; as outras, ler);
 *   - Read, Grep ou Glob dentro da pasta de memórias (memoriesDir).
 *
 * Um agente está "na sequência" quando a ÚLTIMA ferramenta do turno em curso é
 * uma consulta à memória (o principal pelas mensagens depois da última do
 * usuário; o subagente pelos passos da trilha rodando). Várias seguidas são
 * uma ida só; ele fica na estante até a sequência acabar e mais LINGER_S (o
 * cérebro conta: a ida não vira um vaivém quando a consulta é rápida).
 */
import { normalizePath } from '@shared/pathGuard'
import type { OfficeFeed } from '../office/adapter/feed'
import type { OfficeCharacterModel } from '../office/adapter/model'

/** Quanto ele ainda fica na estante depois da última consulta (s). */
export const LINGER_S = 6

export type MemoryUse = 'read' | 'write'

const READERS = new Set(['Read', 'Grep', 'Glob'])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A chamada é consulta à memória? 'write' (memory_propose), 'read' ou null. */
export function memoryUse(name: string, input: unknown, memoriesDir: string | null): MemoryUse | null {
  if (name.startsWith('mcp__memory__')) return name === 'mcp__memory__memory_propose' ? 'write' : 'read'
  if (!READERS.has(name) || !memoriesDir) return null
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const p = str(o.file_path) || str(o.path) || (name === 'Glob' ? str(o.pattern) : '')
  if (!p) return null
  const dir = normalizePath(memoriesDir)
  const n = normalizePath(p)
  return n === dir || n.startsWith(`${dir}/`) ? 'read' : null
}

type Char = Pick<OfficeCharacterModel, 'key' | 'convId' | 'role' | 'trackId'>

/** Quem está na sequência agora: a chave e se gravou nela. */
export function scanMemorySequences(feed: OfficeFeed, characters: readonly Char[], memoriesDir: string | null): Map<string, MemoryUse> {
  const out = new Map<string, MemoryUse>()
  for (const ch of characters) {
    let seq: MemoryUse | null = null
    if (ch.trackId) {
      const t = feed.tracks[ch.convId]?.[ch.trackId]
      if (t?.status !== 'running') continue
      for (let i = t.steps.length - 1; i >= 0; i--) {
        const use = memoryUse(t.steps[i].name, t.steps[i].input, memoriesDir)
        if (!use) break
        seq = seq === 'write' || use === 'write' ? 'write' : 'read'
      }
    } else if (ch.role === 'principal') {
      if (!feed.busyIds.has(ch.convId)) continue
      const msgs = feed.conversations.find((c) => c.id === ch.convId)?.messages ?? []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.kind === 'user') break
        if (m.kind !== 'tool-use' || m.parentToolUseId != null) continue
        const use = memoryUse(m.name, m.input, memoriesDir)
        if (!use) break
        seq = seq === 'write' || use === 'write' ? 'write' : 'read'
      }
    }
    if (seq) out.set(ch.key, seq)
  }
  return out
}
