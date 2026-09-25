import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { changedConversations, outboxItemsFor, restoreOutbox, type OutboxItemLike } from './outboxSync'

/**
 * Liga a fila de espera do App ao banco (tabela `conversation_outbox`): no
 * boot, depois que as conversas carregam, restaura o que ficou na fila antes
 * do reinício; depois, a cada mudança da fila, regrava só as conversas que
 * mudaram. Nada é gravado antes da restauração — senão a fila vazia do boot
 * apagaria a gravada.
 */
export function useOutboxPersistence<T extends OutboxItemLike>(opts: {
  hydrated: boolean
  queue: readonly T[]
  setQueue: Dispatch<SetStateAction<T[]>>
  isPayload: (value: unknown) => value is Omit<T, 'convId' | 'id'>
  onRestored: (restored: readonly T[]) => void
}): void {
  const { hydrated, queue, setQueue, isPayload, onRestored } = opts
  const [ready, setReady] = useState(false)
  const startedRef = useRef(false)
  const savedRef = useRef<readonly T[]>([])
  const onRestoredRef = useRef(onRestored)
  onRestoredRef.current = onRestored

  useEffect(() => {
    if (!hydrated || startedRef.current) return
    startedRef.current = true
    void (async () => {
      try {
        const entries = (await window.api.outboxList?.()) ?? []
        const restored = restoreOutbox<T>(entries, isPayload)
        savedRef.current = restored
        if (restored.length > 0) {
          const ids = new Set(restored.map((item) => item.id))
          setQueue((current) => [...restored, ...current.filter((item) => !ids.has(item.id))])
          onRestoredRef.current(restored)
        }
      } catch {
        // Banco indisponível: segue com a fila em memória (como antes).
      } finally {
        setReady(true)
      }
    })()
  }, [hydrated, isPayload, setQueue])

  useEffect(() => {
    if (!ready) return
    const changed = changedConversations(savedRef.current, queue)
    savedRef.current = queue
    for (const convId of changed) {
      void window.api.outboxReplace?.(convId, outboxItemsFor(queue, convId)).catch(() => undefined)
    }
  }, [ready, queue])
}
