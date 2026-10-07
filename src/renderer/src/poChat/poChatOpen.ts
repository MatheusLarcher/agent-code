import { useSyncExternalStore } from 'react'

/**
 * Onde o "Fala, PO" está aberto: a pasta do projeto (null = fechado). Um
 * estado só para quem abre e quem mostra — o botão do quadro e o "Voltar"
 * (usePoChatPanel), o clique no PO do escritório (Office3DWorkspace) e o
 * cabeçalho do chat flutuante do escritório (OfficeChatFloat) —, sem passar
 * props pelo App.
 */
type Listener = () => void

let current: string | null = null
const listeners = new Set<Listener>()

export const poChatOpen = {
  get(): string | null {
    return current
  },
  set(cwd: string | null): void {
    if (cwd === current) return
    current = cwd
    for (const l of listeners) l()
  },
  subscribe(l: Listener): () => void {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }
}

/** A pasta do projeto do "Fala, PO" aberto (null fechado), acompanhando as mudanças. */
export function usePoChatOpen(): string | null {
  return useSyncExternalStore(poChatOpen.subscribe, poChatOpen.get)
}

/** O nome curto do projeto: o último pedaço da pasta. */
export function projectNameOf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
}
