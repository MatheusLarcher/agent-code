/**
 * Aberto/fechado de cada linha-resumo do chat, guardado pelo id da resposta
 * (chatSteps.ts) — fora dos componentes, então sobrevive a mensagens novas, à
 * paginação e à troca de conversa. Só em memória (ao reabrir o app, tudo
 * recolhido). PC e celular usam o mesmo.
 */
import { useCallback, useSyncExternalStore } from 'react'

/** Teto de ids lembrados (os mais antigos saem primeiro). */
const MAX_OPEN = 500

const opened = new Set<string>()
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function isStepOpen(id: string): boolean {
  return opened.has(id)
}

export function setStepOpen(id: string, open: boolean): void {
  if (open === opened.has(id)) return
  if (open) {
    opened.add(id)
    if (opened.size > MAX_OPEN) opened.delete(opened.values().next().value as string)
  } else opened.delete(id)
  listeners.forEach((fn) => fn())
}

/** Para testes: tudo recolhido de novo. */
export function resetStepOpen(): void {
  opened.clear()
  listeners.forEach((fn) => fn())
}

/** [aberta?, alternar] da linha-resumo da resposta `id`. */
export function useStepOpen(id: string): [boolean, () => void] {
  const open = useSyncExternalStore(subscribe, () => opened.has(id), () => false)
  const toggle = useCallback(() => setStepOpen(id, !opened.has(id)), [id])
  return [open, toggle]
}
