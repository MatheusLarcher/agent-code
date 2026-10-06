/**
 * Chave de comparação do visual dos agentes — só DEV (Ctrl+Alt+Shift+V):
 * põe TODOS os agentes de boneco (agentModels.ts) e volta ao elenco de
 * avatares (o padrão), para comparar e medir o desempenho dos dois.
 */
import { useEffect } from 'react'
import { avatarsOff, setAvatarsOff } from './agentModels'

export function isAvatarShortcut(e: Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'key'>): boolean {
  return e.ctrlKey && e.altKey && e.shiftKey && e.key.toLowerCase() === 'v'
}

/** Escuta o atalho enquanto a aba do escritório está aberta (só em DEV). */
export function useAvatarPreviewKey(active: boolean): void {
  useEffect(() => {
    if (!import.meta.env.DEV || !active) return
    const onKey = (e: KeyboardEvent): void => {
      if (!isAvatarShortcut(e)) return
      e.preventDefault()
      const off = setAvatarsOff(!avatarsOff())
      console.info(`[escritório] visual dos agentes: ${off ? 'boneco (comparação)' : 'elenco de avatares'}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}
