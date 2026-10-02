/**
 * Dublê dos testes do useCentral (não é teste): um "App" mínimo em volta do hook —
 * conversas em estado React, ocupado/fila/em voo como no App, e uma `dispatch`
 * falsa com o comportamento que importa (ocupada → fila do destino; livre → bolha
 * com o id pré-definido, ocupada, em voo). O window.api é simulado por teste.
 */
import { useCallback, useRef, useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import type { PermissionRequest } from '@shared/ipc'
import { CENTRAL_ID, type CentralEntry, type CentralRequestEntry } from '@shared/central'
import type { Conversation, UIMessage } from '../types'
import { useCentral, type CentralDispatch, type CentralQueueItem, type UseCentralDeps } from './useCentral'

export const ROOT = 'C:\\local\\sandbox'
export const SELF = 'pc-1'

export const conv = (id: string, cwd: string, title: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  title,
  cwd,
  model: 'claude-opus-4-8',
  sdkSessionId: null,
  messages: [],
  tokens: { context: 0, output: 0, cost: 0 },
  createdAt: 1,
  updatedAt: 1,
  ...extra
})

export const centralConv = (entries: CentralEntry[] = []): Conversation =>
  conv(CENTRAL_ID, '', 'Central', { mode: 'central', titleSource: 'user', central: { entries } })

export interface KitSpies {
  /** Cada `patchConv`, pelo id (o espelho conta as gravações da Central por aqui). */
  patch: ReturnType<typeof vi.fn>
  dispatch: ReturnType<typeof vi.fn>
  createConversation: ReturnType<typeof vi.fn>
  deleteQueued: ReturnType<typeof vi.fn>
  stopKeepingQueue: ReturnType<typeof vi.fn>
  respondToPermission: ReturnType<typeof vi.fn>
  selectConversationAt: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  needTypesafe: ReturnType<typeof vi.fn>
  loadByIds: ReturnType<typeof vi.fn>
}

export interface KitOptions {
  /** Conversas cuja dispatch "falha" (não fica ocupada nem enfileira). */
  failDispatch?: Set<string>
  over?: Partial<UseCentralDeps>
}

export function mountCentral(initial: Conversation[], opts: KitOptions = {}) {
  const spies: KitSpies = {
    patch: vi.fn(),
    dispatch: vi.fn(),
    createConversation: vi.fn(),
    deleteQueued: vi.fn(),
    stopKeepingQueue: vi.fn(),
    respondToPermission: vi.fn(async () => {}),
    selectConversationAt: vi.fn(),
    notify: vi.fn(),
    needTypesafe: vi.fn(),
    loadByIds: vi.fn(async (): Promise<Conversation[]> => [])
  }
  const queueRef = { current: [] as CentralQueueItem[] }
  const inflightRef = { current: {} as Record<string, { msgId: string } | undefined> }
  let created = 0
  const hook = renderHook(() => {
    const [conversations, setConversations] = useState(initial)
    const convsRef = useRef(conversations)
    convsRef.current = conversations
    const busyRef = useRef<Set<string>>(new Set())
    const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
    const [permissions, setPermissions] = useState<Record<string, PermissionRequest>>({})
    const setBusy = useCallback((id: string, on: boolean) => {
      const next = new Set(busyRef.current)
      if (on) next.add(id)
      else next.delete(id)
      busyRef.current = next
      setBusyIds(next)
    }, [])
    const patchConv = useCallback((id: string, fn: (c: Conversation) => Conversation) => {
      spies.patch(id)
      setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)))
    }, [])
    const addMessages = useCallback(
      (id: string, ...messages: UIMessage[]) => patchConv(id, (c) => ({ ...c, messages: [...c.messages, ...messages] })),
      [patchConv]
    )
    const dispatch = useCallback<CentralDispatch>(
      async (c, text, images, thumbs, files, fileRefs, msgId) => {
        spies.dispatch(c.id, text, msgId, { images, thumbs, files, fileRefs })
        if (opts.failDispatch?.has(c.id)) return
        if (busyRef.current.has(c.id)) {
          queueRef.current = [...queueRef.current, { id: `q-${msgId}`, convId: c.id, msgId }]
          return
        }
        setBusy(c.id, true)
        inflightRef.current[c.id] = { msgId }
        addMessages(c.id, { kind: 'user', id: msgId, text })
      },
      [setBusy, addMessages]
    )
    const createConversation = useCallback((cwd: string): Conversation => {
      spies.createConversation(cwd)
      const fresh = conv(`new${++created}`, cwd, 'Nova conversa')
      setConversations((prev) => [fresh, ...prev])
      return fresh
    }, [])
    const central = useCentral({
      hydrated: true,
      conversations,
      convsRef,
      busyIds,
      busyRef,
      queueRef,
      inflightRef,
      permissions,
      device: SELF,
      sandboxRoot: ROOT,
      projectIcons: {},
      typesafeReady: true,
      needTypesafe: spies.needTypesafe,
      ensure: async () => convsRef.current.find((c) => c.id === CENTRAL_ID) ?? null,
      patchConv,
      addLoaded: (c) => setConversations((prev) => (prev.some((x) => x.id === c.id) ? prev : [c, ...prev])),
      loadByIds: spies.loadByIds,
      createConversation,
      dispatch,
      deleteQueued: spies.deleteQueued,
      stopKeepingQueue: spies.stopKeepingQueue,
      respondToPermission: spies.respondToPermission,
      selectConversationAt: spies.selectConversationAt,
      notify: spies.notify,
      ...opts.over
    })
    return { central, conversations, setBusy, setPermissions, addMessages, patchConv }
  })
  const world = () => hook.result.current
  const entries = (): CentralEntry[] =>
    world().conversations.find((c) => c.id === CENTRAL_ID)?.central?.entries ?? []
  const requests = (): CentralRequestEntry[] => entries().filter((e): e is CentralRequestEntry => e.kind === 'request')
  const find = (id: string) => world().conversations.find((c) => c.id === id)
  /** Roda algo que mexe no estado e deixa as promessas assentarem. */
  const run = async (fn: () => unknown): Promise<void> => {
    await act(async () => {
      await fn()
    })
  }
  return { hook, world, spies, queueRef, inflightRef, entries, requests, find, run }
}
