/**
 * Espaço da Tela de Planejamento: largura do roteiro (arrastável), roteiro
 * recolhido e o chat do Manager minimizado. As três escolhas valem entre
 * sessões (localStorage — síncrono, então a tela já abre do jeito que o
 * usuário deixou; localPrefs).
 */
import { loadFlag, readPref, saveFlag, writePref } from '../localPrefs'

export const ROTEIRO_DEFAULT_W = 220
export const ROTEIRO_MIN_W = 180
/** O roteiro nunca passa de 40% da área da tela (roteiro + canvas). */
export const ROTEIRO_MAX_RATIO = 0.4
/** Passo das setas do teclado na alça. */
export const ROTEIRO_KEY_STEP = 16

/** Minimapa do canvas (canto superior direito) e a margem dos painéis do React Flow. */
export const MINIMAP_W = 168
export const MINIMAP_H = 108
export const FLOW_PANEL_MARGIN = 15

const ROTEIRO_W_KEY = 'agentcode.planning.roteiroWidth'
const ROTEIRO_KEY = 'agentcode.planning.roteiroCollapsed'
const CHAT_MIN_KEY = 'agentcode.planning.chatMinimized'

/** Maior largura do roteiro numa área de `containerWidth` (0 = ainda não medida). */
export function maxRoteiroWidth(containerWidth: number): number {
  if (!(containerWidth > 0)) return Infinity
  return Math.max(ROTEIRO_MIN_W, Math.floor(containerWidth * ROTEIRO_MAX_RATIO))
}

/** Largura do roteiro dentro de [ROTEIRO_MIN_W, 40% da área]. */
export function clampRoteiroWidth(width: number, containerWidth: number): number {
  const w = Number.isFinite(width) ? Math.round(width) : ROTEIRO_DEFAULT_W
  return Math.min(Math.max(w, ROTEIRO_MIN_W), maxRoteiroWidth(containerWidth))
}

export function loadRoteiroWidth(): number {
  const raw = readPref(ROTEIRO_W_KEY)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? clampRoteiroWidth(n, 0) : ROTEIRO_DEFAULT_W
}

export function saveRoteiroWidth(width: number): void {
  writePref(ROTEIRO_W_KEY, String(Math.round(width)))
}

export function loadRoteiroCollapsed(): boolean {
  return loadFlag(ROTEIRO_KEY)
}

export function saveRoteiroCollapsed(collapsed: boolean): void {
  saveFlag(ROTEIRO_KEY, collapsed)
}

/** Padrão: maximizado. */
export function loadChatMinimized(): boolean {
  return loadFlag(CHAT_MIN_KEY)
}

export function saveChatMinimized(minimized: boolean): void {
  saveFlag(CHAT_MIN_KEY, minimized)
}
