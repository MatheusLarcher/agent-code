import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import type { HandoffProjectSnapshot } from '@shared/handoffProject'
import { projectHoldsChat } from './projectQueue'

/**
 * A foto da FILA DO PROJETO no renderer: chega do main (handoff:projectChanged)
 * e é lida na abertura. O `dispatch` do App pergunta, de forma síncrona, se a
 * mensagem de uma conversa fica guardada (`held`); quando uma conversa deixa de
 * estar guardada (o PO decidiu, o outro plano terminou, "Enviar agora mesmo
 * assim"), `onRelease` solta a fila do chat dela.
 */

export interface ProjectQueueDeps {
  api: Pick<AgentCodeApi, 'handoffProjectStatus' | 'onHandoffProjectChanged'> | null
  /** A conversa deixou de estar guardada: a fila do chat dela pode sair. */
  onRelease(conversationId: string): void
}

export interface ProjectQueueHandle {
  snapshot: HandoffProjectSnapshot | null
  /** A mensagem desta conversa fica guardada agora? (síncrono, para o dispatch; gasta a licença do `allowOnce`) */
  held(conversationId: string): boolean
  /** A mesma pergunta sem gastar a licença (a fila do chat no fim do turno). */
  holds(conversationId: string): boolean
  /** O gate do main acabou de soltar um prompt desta conversa: não segure este envio. */
  allowOnce(conversationId: string): void
  /** Relê a foto (quando o main disse que a conversa está livre e a foto ainda não chegou). */
  refresh(): Promise<void>
}

function heldIds(snapshot: HandoffProjectSnapshot | null): Set<string> {
  const out = new Set<string>()
  for (const folder of snapshot?.folders ?? []) {
    for (const plan of folder.plans) if (projectHoldsChat(snapshot, plan.conversationId)) out.add(plan.conversationId)
  }
  return out
}

export function useProjectQueue(hydrated: boolean, deps: ProjectQueueDeps): ProjectQueueHandle {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const [snapshot, setSnapshot] = useState<HandoffProjectSnapshot | null>(null)
  const snapshotRef = useRef<HandoffProjectSnapshot | null>(null)
  const allowed = useRef(new Set<string>())

  const apply = useCallback((next: HandoffProjectSnapshot) => {
    if (!next || !Array.isArray(next.folders)) return
    const before = heldIds(snapshotRef.current)
    snapshotRef.current = next
    setSnapshot(next)
    const after = heldIds(next)
    for (const id of before) {
      // Fora do setState: a fila sai pelo caminho normal de despacho.
      if (!after.has(id)) setTimeout(() => depsRef.current.onRelease(id), 0)
    }
  }, [])

  const refresh = useCallback(async () => {
    const api = depsRef.current.api
    if (!api || typeof api.handoffProjectStatus !== 'function') return
    try {
      const res = await api.handoffProjectStatus()
      if (res?.ok) apply(res.snapshot)
    } catch {
      // Sem a foto, nada fica guardado: a conversa segue como antes.
    }
  }, [apply])

  useEffect(() => {
    const api = depsRef.current.api
    if (!api || typeof api.onHandoffProjectChanged !== 'function') return
    return api.onHandoffProjectChanged((next) => apply(next))
  }, [apply])

  useEffect(() => {
    if (hydrated) void refresh()
  }, [hydrated, refresh])

  const held = useCallback((conversationId: string) => {
    if (allowed.current.delete(conversationId)) return false
    return projectHoldsChat(snapshotRef.current, conversationId)
  }, [])

  const holds = useCallback((conversationId: string) => projectHoldsChat(snapshotRef.current, conversationId), [])

  const allowOnce = useCallback((conversationId: string) => {
    allowed.current.add(conversationId)
    // Envio que nem chegou a perguntar (pasta sumiu, erro antes): a licença não sobra para outro.
    setTimeout(() => allowed.current.delete(conversationId), 5_000)
  }, [])

  return { snapshot, held, holds, allowOnce, refresh }
}
