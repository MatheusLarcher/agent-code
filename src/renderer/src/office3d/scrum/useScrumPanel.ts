/**
 * Os dados do painel do Scrum Master (ScrumPanel.tsx), lidos só com ele aberto:
 * a aba Agora e os tiles (scrumPanel), o Histórico filtrado (scrumHistory), a
 * conversa guardada (scrumChatHistory, paginada pelo fim) e as ações. Cada linha
 * nova do diário (onScrumChanged) relê o Agora e o Histórico; o tempo ativo
 * anda sozinho, então o Agora também é relido a cada REFRESH_MS.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import type { AppConfig } from '@shared/ipc'
import type { ScrumChatMessage, ScrumDecisao, ScrumHistoryItem, ScrumHistoryRequest, ScrumPanelSnapshot } from '@shared/scrumPanel'

export type ScrumPanelApi = Partial<
  Pick<AgentCodeApi, 'scrumPanel' | 'scrumHistory' | 'scrumChatHistory' | 'scrumAsk' | 'scrumDecideDeclaration' | 'onScrumChanged' | 'setConfig' | 'handoffQueueEdit'>
>

export const REFRESH_MS = 20_000
export const CHAT_PAGE = 200
const CHANGED_DEBOUNCE_MS = 250

function appApi(): ScrumPanelApi {
  return (globalThis as { window?: { api?: ScrumPanelApi } }).window?.api ?? {}
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface ScrumPanelData {
  snapshot: ScrumPanelSnapshot | null
  /** A leitura do Agora falhou (o painel mostra e oferece "tentar de novo"). */
  error: string | null
  history: { items: ScrumHistoryItem[]; total: number } | null
  historyError: string | null
  histReq: ScrumHistoryRequest
  setHistReq: (patch: Partial<ScrumHistoryRequest>) => void
  /** Toda decisão já vista no Histórico, pelo id (o "Sobre: …" da conversa). */
  decisions: ReadonlyMap<string, ScrumDecisao>
  chat: ScrumChatMessage[]
  chatMore: boolean
  chatError: string | null
  loadOlderChat: () => void
  asking: boolean
  /** null = deu certo; senão, o motivo. */
  ask: (text: string, sobre: string | null, contestar?: boolean) => Promise<string | null>
  decide: (envioId: string, entregaId: string, aprovar: boolean) => Promise<string | null>
  dequeue: (envioId: string) => Promise<string | null>
  setPodeParar: (on: boolean) => Promise<string | null>
  reload: () => void
}

export function useScrumPanel(api: ScrumPanelApi = appApi()): ScrumPanelData {
  const apiRef = useRef(api)
  apiRef.current = api
  const [snapshot, setSnapshot] = useState<ScrumPanelSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<ScrumPanelData['history']>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [histReq, setReq] = useState<ScrumHistoryRequest>({ filtro: 'tudo', periodo: '7d', busca: '' })
  const [decisions, setDecisions] = useState<ReadonlyMap<string, ScrumDecisao>>(new Map())
  const [chat, setChat] = useState<ScrumChatMessage[]>([])
  const [chatMore, setChatMore] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const alive = useRef(true)
  const reqRef = useRef(histReq)
  reqRef.current = histReq
  // A última leitura vence: uma resposta antiga (filtro trocado no meio) não sobrescreve a nova.
  const histSeq = useRef(0)
  const panelSeq = useRef(0)

  const loadPanel = useCallback(async (): Promise<void> => {
    const fn = apiRef.current.scrumPanel
    if (!fn) return setError('O painel do Scrum Master não está disponível nesta versão.')
    const seq = ++panelSeq.current
    try {
      const r = await fn()
      if (!alive.current || seq !== panelSeq.current) return
      if (r.ok) {
        setSnapshot(r.snapshot)
        setError(null)
      } else setError(r.message)
    } catch (e) {
      if (alive.current && seq === panelSeq.current) setError(errText(e))
    }
  }, [])

  const loadHistory = useCallback(async (): Promise<void> => {
    const fn = apiRef.current.scrumHistory
    if (!fn) return
    const seq = ++histSeq.current
    try {
      const r = await fn(reqRef.current)
      if (!alive.current || seq !== histSeq.current) return
      if (!r.ok) return setHistoryError(r.message)
      setHistory({ items: r.items, total: r.total })
      setHistoryError(null)
      setDecisions((prev) => {
        const next = new Map(prev)
        for (const it of r.items) next.set(it.decisao.id, it.decisao)
        return next
      })
    } catch (e) {
      if (alive.current && seq === histSeq.current) setHistoryError(errText(e))
    }
  }, [])

  const loadChat = useCallback(async (skip: number): Promise<void> => {
    const fn = apiRef.current.scrumChatHistory
    if (!fn) return
    try {
      const r = await fn({ skip, limit: CHAT_PAGE })
      if (!alive.current) return
      if (!r.ok) return setChatError(r.message)
      setChatError(null)
      setChatMore(r.hasMore)
      setChat((prev) => (skip === 0 ? r.messages : [...r.messages, ...prev]))
    } catch (e) {
      if (alive.current) setChatError(errText(e))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void loadPanel()
    void loadChat(0)
    const timer = setInterval(() => void loadPanel(), REFRESH_MS)
    let pending: ReturnType<typeof setTimeout> | null = null
    const off = apiRef.current.onScrumChanged?.(() => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        void loadPanel()
        void loadHistory()
      }, CHANGED_DEBOUNCE_MS)
    })
    return () => {
      alive.current = false
      clearInterval(timer)
      if (pending) clearTimeout(pending)
      off?.()
    }
  }, [loadPanel, loadChat, loadHistory])

  // O Histórico relê a cada troca de filtro, período ou busca.
  useEffect(() => {
    void loadHistory()
  }, [histReq, loadHistory])

  const setHistReq = useCallback((patch: Partial<ScrumHistoryRequest>) => setReq((r) => ({ ...r, ...patch })), [])
  const loadOlderChat = useCallback(() => void loadChat(chat.length), [loadChat, chat.length])

  const ask = useCallback(async (text: string, sobre: string | null, contestar?: boolean): Promise<string | null> => {
    const fn = apiRef.current.scrumAsk
    if (!fn) return 'A conversa com o Scrum Master não está disponível nesta versão.'
    setAsking(true)
    try {
      const r = await fn({ text, sobre, ...(contestar ? { contestar: true } : {}) })
      if (!r.ok) return r.message
      if (alive.current) setChat((prev) => [...prev, ...r.messages])
      return null
    } catch (e) {
      return errText(e)
    } finally {
      if (alive.current) setAsking(false)
    }
  }, [])

  const decide = useCallback(
    async (envioId: string, entregaId: string, aprovar: boolean): Promise<string | null> => {
      const fn = apiRef.current.scrumDecideDeclaration
      if (!fn) return 'Indisponível nesta versão.'
      try {
        const r = await fn({ envioId, entregaId, aprovar })
        void loadPanel()
        return r.ok ? null : r.message
      } catch (e) {
        return errText(e)
      }
    },
    [loadPanel]
  )

  const dequeue = useCallback(
    async (envioId: string): Promise<string | null> => {
      const fn = apiRef.current.handoffQueueEdit
      if (!fn) return 'Indisponível nesta versão.'
      try {
        const r = await fn({ envioId, acao: 'tirar' })
        void loadPanel()
        return r.ok ? null : r.message
      } catch (e) {
        return errText(e)
      }
    },
    [loadPanel]
  )

  const setPodeParar = useCallback(
    async (on: boolean): Promise<string | null> => {
      const fn = apiRef.current.setConfig
      if (!fn) return 'Indisponível nesta versão.'
      setSnapshot((s) => (s ? { ...s, podeParar: on } : s))
      try {
        await fn({ board: { scrumMaster: { podeParar: on } } as AppConfig['board'] })
        void loadPanel()
        return null
      } catch (e) {
        void loadPanel()
        return errText(e)
      }
    },
    [loadPanel]
  )

  const reload = useCallback(() => {
    void loadPanel()
    void loadHistory()
    void loadChat(0)
  }, [loadPanel, loadHistory, loadChat])

  return { snapshot, error, history, historyError, histReq, setHistReq, decisions, chat, chatMore, chatError, loadOlderChat, asking, ask, decide, dequeue, setPodeParar, reload }
}
