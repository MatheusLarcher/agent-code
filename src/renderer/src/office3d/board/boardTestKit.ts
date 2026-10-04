/** Fábricas de cartão/evento e um window.api falso do Quadro, só para os testes do quadro 3D. */
import type { BoardItem, BoardItemEvent, BoardItemStatus, ProjectBoard } from '@shared/ipc'
import type { BoardApi } from './boardSync'

export function item(id: string, over: Partial<BoardItem> = {}): BoardItem {
  return {
    id,
    projectId: 'p1',
    projectCwd: 'C:/proj',
    conversationId: 'c1',
    origin: 'agent',
    sourceId: id,
    sourceTitle: `Tarefa ${id}`,
    sourceStatus: 'pending',
    activeForm: null,
    seq: 0,
    poTitle: null,
    poNote: null,
    poStatus: null,
    poReason: null,
    poAt: null,
    dismissedAt: null,
    revision: 1,
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
    ...over
  }
}

let seq = 0
export function event(boardItemId: string, at: string, over: Partial<BoardItemEvent> = {}): BoardItemEvent {
  return { id: `e${++seq}`, boardItemId, at, kind: 'status_changed', actor: 'agent', fromStatus: null, toStatus: null, note: null, ...over }
}

export const at = (min: number): string => new Date(Date.UTC(2026, 9, 3, 10, min)).toISOString()

/** Um quadro falso: `board` é o que boardList devolve; `events[id]` a linha do tempo (ou um Error). */
export function fakeBoardApi(initial: ProjectBoard = { available: true, items: [] }) {
  const state = {
    board: initial,
    events: {} as Record<string, BoardItemEvent[] | Error>,
    moveResult: { ok: true } as { ok: boolean; message?: string },
    listeners: [] as Array<(m: { projectId: string }) => void>
  }
  const api = {
    boardList: vitestFn(async (_q: { projectCwd: string }) => state.board),
    boardItemEvents: vitestFn(async (id: string) => {
      const e = state.events[id]
      if (e instanceof Error) throw e
      return e ?? []
    }),
    onBoardChanged: (cb: (m: { projectId: string }) => void) => {
      state.listeners.push(cb)
      return () => {
        state.listeners = state.listeners.filter((l) => l !== cb)
      }
    },
    boardMove: vitestFn(async (_id: string, _to: BoardItemStatus) => state.moveResult),
    boardDismiss: vitestFn(async (id: string, dismissed: boolean) => {
      const it = state.board.items.find((i) => i.id === id)
      if (!it) return null
      state.board = { ...state.board, items: state.board.items.filter((i) => i.id !== id) }
      return { ...it, dismissedAt: dismissed ? new Date(0).toISOString() : null }
    })
  }
  const emit = (projectId = 'p1'): void => {
    for (const l of state.listeners) l({ projectId })
  }
  return { api: api as BoardApi & typeof api, state, emit }
}

/** Espião mínimo (conta as chamadas) sem depender do `vi` fora dos testes. */
function vitestFn<A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) & { calls: A[] } {
  const calls: A[] = []
  const wrapped = ((...args: A) => {
    calls.push(args)
    return fn(...args)
  }) as ((...args: A) => R) & { calls: A[] }
  wrapped.calls = calls
  return wrapped
}

/** Deixa as promessas pendentes (leituras do quadro e dos eventos) terminarem. */
export async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}
