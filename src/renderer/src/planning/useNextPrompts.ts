import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import type { HandoffProjectSnapshot } from '@shared/handoffProject'
import type { HandoffQueueItem } from '@shared/handoffTracking'

/**
 * Os dados da faixa "Próximos prompts" de uma pasta: os prompts que esperam
 * (handoff:queueList, com o estado e o motivo decididos no main) e a foto da
 * fila do projeto. Relê quando o main avisa (handoff:changed, a foto nova).
 */

export type NextPromptsApi = Pick<AgentCodeApi, 'handoffQueueList' | 'handoffProjectStatus' | 'onHandoffChanged' | 'onHandoffProjectChanged'>

/** Junta os avisos em rajada (o acompanhamento escreve várias vezes por turno). */
const RELOAD_DEBOUNCE_MS = 150

export function useNextPrompts(
  projectCwd: string | null,
  api: NextPromptsApi | null
): { items: HandoffQueueItem[]; snapshot: HandoffProjectSnapshot | null; available: boolean; reload: () => Promise<void> } {
  const [items, setItems] = useState<HandoffQueueItem[]>([])
  const [snapshot, setSnapshot] = useState<HandoffProjectSnapshot | null>(null)
  const [available, setAvailable] = useState(true)
  const apiRef = useRef(api)
  apiRef.current = api
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const a = apiRef.current
    if (!projectCwd || !a || typeof a.handoffQueueList !== 'function') {
      setItems([])
      return
    }
    const mine = ++seq.current
    try {
      const [list, status] = await Promise.all([
        a.handoffQueueList({ projectCwd }),
        typeof a.handoffProjectStatus === 'function' ? a.handoffProjectStatus() : Promise.resolve(null)
      ])
      // Uma resposta velha (pasta trocada no meio) não sobrescreve a nova.
      if (mine !== seq.current) return
      setAvailable(!!list?.ok)
      setItems(list?.ok ? list.items : [])
      if (status?.ok) setSnapshot(status.snapshot)
    } catch {
      if (mine === seq.current) setAvailable(false)
    }
  }, [projectCwd])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    const a = apiRef.current
    if (!a) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS)
    }
    const offChanged = typeof a.onHandoffChanged === 'function' ? a.onHandoffChanged(soon) : undefined
    const offProject =
      typeof a.onHandoffProjectChanged === 'function'
        ? a.onHandoffProjectChanged((next) => {
            if (next && Array.isArray(next.folders)) setSnapshot(next)
            soon()
          })
        : undefined
    return () => {
      if (timer) clearTimeout(timer)
      offChanged?.()
      offProject?.()
    }
  }, [reload])

  return { items, snapshot, available, reload }
}
