/**
 * O Quadro de um projeto no celular: lê pelo `window.api` da ponte (o MESMO
 * canal do PC), relê no aviso `board:changed` e move/arquiva com a resposta do
 * PC. Mover é otimista: o cartão muda de coluna na hora e volta se o PC recusar.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import type { BoardItem, BoardItemStatus, ProjectBoard } from '@shared/ipc'
import { toast } from '../app/runtime'
import { errorText } from '../core/net'

type BoardApi = Partial<Pick<AgentCodeApi, 'boardList' | 'boardMove' | 'boardDismiss' | 'onBoardChanged'>>

/** O `window.api` da hora (a ponte é instalada no início do app). */
export function boardApi(): BoardApi {
  return (window as unknown as { api?: BoardApi }).api ?? {}
}

export type BoardStatus = 'loading' | 'ready' | 'error'

export interface BoardState {
  status: BoardStatus
  board: ProjectBoard | null
  error: string | null
  /** Id do cartão com um "mover" esperando o PC. */
  moving: string | null
  reload: () => void
  move: (item: BoardItem, to: BoardItemStatus) => Promise<void>
  dismiss: (item: BoardItem) => Promise<void>
}

const textOf = (err: unknown): string => (err instanceof Error && err.message ? err.message : errorText(err))

export function useBoard(projectCwd: string | null, includeDismissed: boolean): BoardState {
  const [status, setStatus] = useState<BoardStatus>('loading')
  const [board, setBoard] = useState<ProjectBoard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  // Só a leitura mais nova vale (trocar de projeto no meio de uma leitura).
  const seq = useRef(0)
  const shown = useRef<ProjectBoard | null>(null)
  shown.current = board

  const load = useCallback(
    async (quiet: boolean): Promise<void> => {
      const id = ++seq.current
      if (!projectCwd) {
        setBoard(null)
        setStatus('ready')
        return
      }
      if (!quiet) {
        setStatus('loading')
        setError(null)
      }
      try {
        const list = boardApi().boardList
        if (!list) throw new Error('O app do PC não tem o Quadro. Atualize o agent-code no PC.')
        const next = await list({ projectCwd, includeDismissed })
        if (id !== seq.current) return
        setBoard(next)
        setError(null)
        setStatus('ready')
      } catch (err) {
        if (id !== seq.current) return
        // A releitura em silêncio que falha não apaga o quadro que já está na tela.
        if (quiet && shown.current) return
        setError(textOf(err))
        setStatus('error')
      }
    },
    [projectCwd, includeDismissed]
  )

  useEffect(() => {
    void load(false)
  }, [load])

  // O main avisa a cada mudança de quadro (de qualquer projeto): relê em silêncio.
  useEffect(() => {
    const on = boardApi().onBoardChanged
    if (!on) return
    return on(() => void load(true))
  }, [load])

  const move = useCallback(
    async (item: BoardItem, to: BoardItemStatus): Promise<void> => {
      const fn = boardApi().boardMove
      if (!fn) return toast('O app do PC não tem esta função. Atualize o agent-code no PC.', 'erro')
      const before = shown.current
      const patch = (b: ProjectBoard | null): ProjectBoard | null => (b ? { ...b, items: b.items.map((it) => (it.id === item.id ? { ...it, poStatus: to } : it)) } : b)
      setBoard(patch)
      setMoving(item.id)
      try {
        const r = await fn(item.id, to)
        if (!r?.ok) {
          setBoard(before)
          toast(r?.message || 'Não foi possível mover o cartão.', 'erro')
          return
        }
        void load(true)
      } catch (err) {
        setBoard(before)
        toast(textOf(err), 'erro')
      } finally {
        setMoving(null)
      }
    },
    [load]
  )

  const dismiss = useCallback(
    async (item: BoardItem): Promise<void> => {
      const fn = boardApi().boardDismiss
      if (!fn) return toast('O app do PC não tem esta função. Atualize o agent-code no PC.', 'erro')
      try {
        await fn(item.id, !item.dismissedAt)
        toast(item.dismissedAt ? 'Cartão restaurado.' : 'Cartão arquivado.')
      } catch (err) {
        toast(textOf(err), 'erro')
      }
      void load(true)
    },
    [load]
  )

  const reload = useCallback(() => void load(false), [load])
  return { status, board, error, moving, reload, move, dismiss }
}
