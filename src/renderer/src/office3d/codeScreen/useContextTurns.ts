/**
 * Os turnos do contexto de uma conversa, pelo IPC do PC (contextTurns:*). Só lê
 * com `enabled` (o app Contexto aberto): fechado, nada é pedido nem assinado.
 *
 *   list       os 10 últimos turnos (mais novo primeiro), com os modelos de cada um
 *   selected   o turno escolhido no seletor (null = o mais novo)
 *   detail     o turno escolhido inteiro (blocos com texto, medição, modelos)
 *   newer      o turno seguinte ao escolhido (para marcar "igual"); null no mais novo
 *
 * O aviso "mudou" da conversa relê a lista e o turno à vista, no máximo uma vez a
 * cada REREAD_MS (um turno ocupado avisa a cada hook e a cada gravação).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ContextTurnDetail, ContextTurnSummary } from '@shared/contextSnapshot'

export const REREAD_MS = 400

export interface ContextTurnsState {
  list: ContextTurnSummary[]
  selected: string | null
  detail: ContextTurnDetail | null
  newer: ContextTurnDetail | null
  loading: boolean
  /** O IPC não existe (testes, celular): a tela diz que não há dados. */
  unavailable: boolean
}

const EMPTY: ContextTurnsState = { list: [], selected: null, detail: null, newer: null, loading: false, unavailable: false }

export function useContextTurns(
  convId: string | null,
  enabled: boolean,
  opts: { parentToolUseId?: string; turnId?: string | null } = {}
): ContextTurnsState & { select: (turnId: string | null) => void } {
  const [state, setState] = useState<ContextTurnsState>(EMPTY)
  const [selected, setSelected] = useState<string | null>(null)
  const pinnedTurn = opts.turnId ?? null
  const parent = opts.parentToolUseId
  const seq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!convId || typeof api?.listContextTurns !== 'function' || typeof api.readContextTurn !== 'function') {
      setState({ ...EMPTY, unavailable: true })
      return
    }
    const mine = ++seq.current
    setState((s) => ({ ...s, loading: true }))
    try {
      const list = await api.listContextTurns(convId)
      const want = pinnedTurn ?? selected ?? list[0]?.turnId ?? null
      const at = want ? list.findIndex((t) => t.turnId === want) : -1
      const newerId = at > 0 ? list[at - 1].turnId : null
      const [detail, newer] = await Promise.all([
        want ? api.readContextTurn(convId, want, parent) : Promise.resolve(null),
        newerId && !parent ? api.readContextTurn(convId, newerId) : Promise.resolve(null)
      ])
      if (mine !== seq.current) return
      setState({ list, selected: want, detail, newer, loading: false, unavailable: false })
    } catch {
      if (mine === seq.current) setState((s) => ({ ...s, loading: false }))
    }
  }, [convId, parent, pinnedTurn, selected])

  useEffect(() => {
    if (!enabled) return
    void load()
  }, [enabled, load])

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!enabled || !convId || typeof api?.onContextTurnsChanged !== 'function') return
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = 0
    const off = api.onContextTurnsChanged((e) => {
      if (e.convId !== convId || timer) return
      const wait = Math.max(0, REREAD_MS - (Date.now() - last))
      timer = setTimeout(() => {
        timer = null
        last = Date.now()
        void load()
      }, wait)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [enabled, convId, load])

  const select = useCallback((turnId: string | null) => setSelected(turnId), [])
  return { ...state, select }
}
