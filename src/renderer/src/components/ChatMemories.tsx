import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContextTurnSummary } from '@shared/contextSnapshot'
import type { UIMessage } from '../types'
import { REREAD_MS } from '../office3d/codeScreen/useContextTurns'
import { chatMemoryEntries, memoryTurnSegments, type ChatMemoryEntry } from './chatMemoryModel'
import { ChatMemoryPreview, useMemoryPreviewReader } from './ChatMemoryPreview'
import './chatContext.css'

/** Só metadados: snapshots e ferramentas já persistidos, nunca texto de memória ou cofre. */
export function useChatMemoryHistory(convId: string | null | undefined, messages: readonly UIMessage[], visibleUsers?: readonly string[]) {
  const [state, setState] = useState<{ convId: string | null | undefined; sent: Map<string, string[]>; dir: string | null; error?: unknown }>({ convId, sent: new Map(), dir: null })
  const [revision, setRevision] = useState(0)
  const seq = useRef(0)
  const cache = useRef(new Map<string, Map<string, string[]>>())
  const dirty = useRef(new Map<string, Set<string>>())
  const segments = useMemo(() => memoryTurnSegments(messages), [messages])
  const visibleKey = visibleUsers ? JSON.stringify(visibleUsers) : ''
  const requests = useMemo(() => {
    const visible = visibleKey ? new Set<string>(JSON.parse(visibleKey)) : null
    return segments.filter((r) => !visible || visible.has(r.userId))
  }, [segments, visibleKey])
  const idsKey = useMemo(() => JSON.stringify([...new Set(requests.flatMap((r) => r.turnIds))]), [requests])
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    const mine = ++seq.current
    if (!convId || typeof api?.listContextTurns !== 'function' || typeof api.readContextTurn !== 'function') return
    const contextApi = api
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const [turns, info] = await Promise.all([contextApi.listContextTurns(convId!), typeof contextApi.getCacheInfo === 'function' ? contextApi.getCacheInfo() : null])
        const sent = new Map(cache.current.get(convId!) ?? [])
        const invalidated = new Set(dirty.current.get(convId!) ?? [])
        turns.forEach((t: ContextTurnSummary) => { sent.set(t.turnId, t.memoriesSent); invalidated.delete(t.turnId) })
        const missing = (JSON.parse(idsKey) as string[]).filter((id) => !sent.has(id) || invalidated.has(id))
        // Históricos longos: apenas os pedidos visíveis, no máximo quatro leituras em voo.
        for (let i = 0; i < missing.length; i += 4) {
          await Promise.all(missing.slice(i, i + 4).map(async (id) => {
            const detail = await contextApi.readContextTurn(convId!, id)
            sent.set(id, detail?.memoriesSent ?? [])
            invalidated.delete(id)
          }))
          if (cancelled) return
        }
        if (!cancelled && mine === seq.current) {
          cache.current.set(convId!, sent)
          dirty.current.set(convId!, invalidated)
          setState({ convId, sent, dir: info?.memoriesDir ?? null })
        }
      } catch (error) {
        if (!cancelled && mine === seq.current) setState((s) => ({ ...(s.convId === convId ? s : { convId, sent: new Map(), dir: null }), error }))
      }
    }
    void load()
    return () => { cancelled = true }
  }, [convId, idsKey, revision])
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!convId || typeof api?.onContextTurnsChanged !== 'function') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = api.onContextTurnsChanged((e) => {
      if (e.convId !== convId) return
      const pending = dirty.current.get(convId) ?? new Set<string>()
      pending.add(e.turnId)
      dirty.current.set(convId, pending)
      ++seq.current // Uma notificação invalida também uma leitura ainda em voo.
      if (timer) return
      timer = setTimeout(() => { timer = undefined; setRevision((r) => r + 1) }, REREAD_MS)
    })
    return () => { off(); clearTimeout(timer) }
  }, [convId])
  const current = state.convId === convId ? state : { sent: new Map<string, string[]>(), dir: null, error: undefined }
  const byUser = useMemo(() => new Map(requests.map((r) => [r.userId, chatMemoryEntries(r.messages, r.turnIds.flatMap((id) => current.sent.get(id) ?? []), current.dir)])), [requests, current.sent, current.dir])
  return { byUser, error: current.error, reload: (): void => setRevision((r) => r + 1) }
}

function Brain(): JSX.Element {
  return <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 5a3 3 0 0 0-5.8-1A3.5 3.5 0 0 0 3 8a4 4 0 0 0-1 6 3.5 3.5 0 0 0 3 5 3.6 3.6 0 0 0 7 1V5Zm0 0a3 3 0 0 1 5.8-1A3.5 3.5 0 0 1 21 8a4 4 0 0 1 1 6 3.5 3.5 0 0 1-3 5 3.6 3.6 0 0 1-7 1" />
    <path d="M6 8c0 2 2 3 3 3m-4 4c1-1 3-1 4 0m9-7c0 2-2 3-3 3m4 4c-1-1-3-1-4 0" />
  </svg>
}

export function ChatMemoryAttachment({ entries, error, onRetry }: { entries: readonly ChatMemoryEntry[]; error?: unknown; onRetry: () => void }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null)
  const [revealing, setRevealing] = useState<string | null>(null)
  // O cache das amostras vive com o cartão: fechar e reabrir a lista não relê.
  const readPreview = useMemoryPreviewReader()
  if (!entries.length && !error) return null
  const reveal = async (memory: string): Promise<void> => {
    setRevealing(memory)
    setNotice(null)
    try {
      const result = await window.api.revealFile({ mode: 'folder', memory })
      setNotice(result)
    } catch {
      setNotice({ ok: false, message: 'Não foi possível mostrar a memória na pasta. Tente novamente.' })
    } finally { setRevealing(null) }
  }
  return <div className="chat-memory-card">
    {entries.length > 0 && <>
      <button type="button" className="chat-memory-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Brain /><span><strong>{entries.length} {entries.length === 1 ? 'memória' : 'memórias'} neste turno</strong><small>Fornecidas no contexto ou lidas explicitamente · ver arquivos</small></span>
      </button>
      {open && <ul className="chat-memory-list">{entries.map((m) => <li key={m.relPath}>
        <ChatMemoryPreview relPath={m.relPath} read={readPreview}>{m.relPath}<small>{[m.supplied ? 'Fornecida no contexto' : '', m.read ? 'Lida pelo agente' : ''].filter(Boolean).join(' · ')}</small></ChatMemoryPreview>
        <button type="button" disabled={revealing !== null} aria-label={`Mostrar ${m.relPath} na pasta`} onClick={() => void reveal(m.relPath)}>{revealing === m.relPath ? 'Abrindo…' : 'Mostrar na pasta'}</button>
      </li>)}</ul>}
    </>}
    {error != null && <p role="alert">Não foi possível atualizar as memórias deste turno. <button type="button" onClick={onRetry}>Tentar novamente</button></p>}
    {notice && <p role={notice.ok ? 'status' : 'alert'}>{notice.message}</p>}
  </div>
}
