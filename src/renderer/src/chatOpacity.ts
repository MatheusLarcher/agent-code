/**
 * Opacidade do fundo dos chats (principal, flutuante do Agent Manager/Escritório
 * 3D/Central e a tela do monitor do agente). Uma escolha só, lembrada no
 * localStorage (localPrefs) e publicada na variável CSS `--chat-bg-alpha` (0.3 a 1)
 * do <html>; cada chat multiplica o fundo que já tinha por ela (100% = o visual de
 * antes). Só o FUNDO varia: texto, bolhas e a caixa de digitação não mudam.
 */
import { useSyncExternalStore } from 'react'
import { readPref, writePref } from './localPrefs'

export const CHAT_OPACITY_KEY = 'agent.chatBgOpacity'
export const CHAT_OPACITY_MIN = 30
export const CHAT_OPACITY_MAX = 100
export const CHAT_OPACITY_STEP = 5
export const CHAT_ALPHA_VAR = '--chat-bg-alpha'

/** Inteiro entre o mínimo e o máximo; qualquer coisa inválida vira 100 (o padrão). */
export function clampChatOpacity(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return CHAT_OPACITY_MAX
  return Math.min(CHAT_OPACITY_MAX, Math.max(CHAT_OPACITY_MIN, Math.round(n)))
}

export function loadChatOpacity(): number {
  const raw = readPref(CHAT_OPACITY_KEY)
  return raw == null ? CHAT_OPACITY_MAX : clampChatOpacity(raw)
}

export function applyChatOpacity(percent: number): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty(CHAT_ALPHA_VAR, String(clampChatOpacity(percent) / 100))
}

let current = loadChatOpacity()
const listeners = new Set<() => void>()
applyChatOpacity(current)

/** Grava, aplica e avisa todos os controles montados. */
export function setChatOpacity(percent: number): void {
  current = clampChatOpacity(percent)
  writePref(CHAT_OPACITY_KEY, String(current))
  applyChatOpacity(current)
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useChatOpacity(): [number, (percent: number) => void] {
  const value = useSyncExternalStore(subscribe, () => current)
  return [value, setChatOpacity]
}

/** Só para testes: relê o storage (como um app recém-aberto). */
export function reloadChatOpacityForTest(): number {
  current = loadChatOpacity()
  applyChatOpacity(current)
  listeners.forEach((l) => l())
  return current
}
