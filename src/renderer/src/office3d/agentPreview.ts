/**
 * Chave de teste do visual novo dos agentes — só DEV (Ctrl+Alt+Shift+V):
 * liga/desliga o avatar GLB v1 em TODOS os agentes (agentModels.ts), com a
 * roupa na cor de cada um. Desligada, o escritório fica como sempre foi.
 */
import { useEffect } from 'react'
import { avatarPreview, setAvatarPreview } from './agentModels'

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
      const on = setAvatarPreview(!avatarPreview())
      console.info(`[escritório] visual dos agentes: ${on ? 'avatar v1 (teste)' : 'boneco'}`)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}
