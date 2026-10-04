/**
 * Os dados do painel de Memórias (só leitura): a lista (memory:list-entries),
 * as propostas em conflito, a pasta de memórias e o uso — das mensagens das
 * conversas (já no feed) e dos turnos de contexto gravados no banco (as
 * memórias que o app escolheu). Lê só com o painel aberto.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ContextTurnSummary } from '@shared/contextSnapshot'
import type { MemoryListItem, MemoryReadResult } from '@shared/memoryPanel'
import type { Conversation } from '../types'
import { usageFromMessages, usageFromTurns, type UsageEvent } from './memoryUsage'

interface PanelApi {
  memoryListEntries?(): Promise<MemoryListItem[]>
  memoryReadEntry?(relPath: string): Promise<MemoryReadResult | null>
  listMemoryConflicts?(): Promise<Array<{ relPath: string }>>
  getCacheInfo?(): Promise<{ memoriesDir?: string }>
  listContextTurns?(convId: string): Promise<ContextTurnSummary[]>
}
const api = (): PanelApi => (globalThis as { window?: { api?: PanelApi } }).window?.api ?? {}

/** Quantas conversas (as mais recentes) têm os turnos de contexto lidos. */
const TURN_CONVS = 30

export interface MemoryPanelData {
  items: MemoryListItem[]
  events: UsageEvent[]
  conflicts: ReadonlySet<string>
  bodies: ReadonlyMap<string, string>
  read: (relPath: string) => Promise<string | null>
  loading: boolean
}

export function useMemoryPanel(open: boolean, conversations: readonly Conversation[]): MemoryPanelData {
  const [items, setItems] = useState<MemoryListItem[]>([])
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(new Set())
  const [memDir, setMemDir] = useState<string | null>(null)
  const [turnEvents, setTurnEvents] = useState<UsageEvent[]>([])
  const [bodies, setBodies] = useState<ReadonlyMap<string, string>>(new Map())
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    let live = true
    const a = api()
    setLoading(true)
    void Promise.all([
      a.memoryListEntries?.().catch(() => []) ?? [],
      a.listMemoryConflicts?.().catch(() => []) ?? [],
      a.getCacheInfo?.().catch(() => ({})) ?? {}
    ]).then(([list, conf, info]) => {
      if (!live) return
      setItems(list as MemoryListItem[])
      setConflicts(new Set((conf as Array<{ relPath: string }>).map((c) => c.relPath)))
      setMemDir((info as { memoriesDir?: string }).memoriesDir ?? null)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [open])

  // Os turnos de contexto das conversas mais recentes (as memórias escolhidas pelo app).
  const recent = useMemo(() => [...conversations].filter((c) => c.cwd).sort((x, y) => y.updatedAt - x.updatedAt).slice(0, TURN_CONVS), [conversations])
  const recentKey = recent.map((c) => `${c.id}@${c.updatedAt}`).join('|')
  useEffect(() => {
    const list = api().listContextTurns
    if (!open || !list) return
    let live = true
    void Promise.all(recent.map((c) => list(c.id).then((t) => usageFromTurns(c, t), () => [] as UsageEvent[]))).then((all) => {
      if (live) setTurnEvents(all.flat())
    })
    return () => {
      live = false
    }
    // recent muda junto com recentKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recentKey])

  const msgEvents = useMemo(() => (open ? conversations.flatMap((c) => usageFromMessages(c, memDir)) : []), [open, conversations, memDir])

  const read = useCallback(async (relPath: string): Promise<string | null> => {
    const r = await api().memoryReadEntry?.(relPath).catch(() => null)
    if (r) setBodies((m) => new Map(m).set(relPath, r.body))
    return r?.body ?? null
  }, [])

  const events = useMemo(() => [...msgEvents, ...turnEvents], [msgEvents, turnEvents])
  return { items, events, conflicts, bodies, read, loading }
}
