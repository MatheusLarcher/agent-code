import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoardItem } from '@shared/ipc'

/** Pedido de fora do painel (o resumo "desde que você saiu", o "Fala, PO") para abrir um cartão pelo id. */
export interface BoardOpenRequest {
  id: string
  /** A conversa dona do cartão: de outra conversa, o painel passa a "Projeto inteiro". */
  conversationId: string
  /** Sobe a cada pedido: o mesmo cartão pedido duas vezes abre duas vezes. */
  seq: number
}

/**
 * Quem pede para abrir um cartão (no App): mostra o painel do Quadro e guarda
 * o pedido até o painel atender (`done`).
 */
export function useBoardCardOpener(showBoard: () => void): {
  request: BoardOpenRequest | null
  open(cardId: string, conversationId: string): void
  done(seq: number): void
} {
  const [request, setRequest] = useState<BoardOpenRequest | null>(null)
  const showRef = useRef(showBoard)
  showRef.current = showBoard
  const open = useCallback((cardId: string, conversationId: string): void => {
    showRef.current()
    setRequest((prev) => ({ id: cardId, conversationId, seq: (prev?.seq ?? 0) + 1 }))
  }, [])
  const done = useCallback((seq: number): void => setRequest((r) => (r?.seq === seq ? null : r)), [])
  return { request, open, done }
}

/**
 * Abre o cartão pedido: na hora, se já está na lista; senão (outra conversa do
 * projeto, ou a lista ainda carregando), passa a "Projeto inteiro" e abre
 * quando ele chegar. `done` avisa que o pedido foi atendido — o painel montado
 * de novo não reabre o mesmo cartão.
 */
export function useBoardOpenRequest(opts: {
  request: BoardOpenRequest | null | undefined
  items: readonly BoardItem[]
  conversationId: string
  wholeProject: boolean
  setWholeProject(on: boolean): void
  open(item: BoardItem): void
  done?(seq: number): void
}): void {
  const pending = useRef<BoardOpenRequest | null>(null)
  const latest = useRef(opts)
  latest.current = opts
  const seq = opts.request?.seq

  const tryOpen = (): void => {
    const req = pending.current
    if (!req) return
    const found = latest.current.items.find((item) => item.id === req.id)
    if (!found) return
    pending.current = null
    latest.current.open(found)
    latest.current.done?.(req.seq)
  }

  useEffect(() => {
    const { request, wholeProject, conversationId, setWholeProject } = latest.current
    if (!request) return
    pending.current = request
    tryOpen()
    if (pending.current && !wholeProject && request.conversationId !== conversationId) setWholeProject(true)
    // Só um pedido novo (seq) dispara; o resto vem do ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq])

  useEffect(() => {
    tryOpen()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.items])
}
