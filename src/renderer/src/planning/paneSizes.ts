/**
 * Espaço da Tela de Planejamento: largura do roteiro (arrastável), roteiro
 * recolhido e o chat do Manager minimizado. As três escolhas valem entre
 * sessões (localStorage — síncrono, então a tela já abre do jeito que o
 * usuário deixou).
 */

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

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Sem storage (modo privado, cota): a escolha vale só nesta sessão.
  }
}

export function loadRoteiroWidth(): number {
  const raw = read(ROTEIRO_W_KEY)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? clampRoteiroWidth(n, 0) : ROTEIRO_DEFAULT_W
}

export function saveRoteiroWidth(width: number): void {
  write(ROTEIRO_W_KEY, String(Math.round(width)))
}

export function loadRoteiroCollapsed(): boolean {
  return read(ROTEIRO_KEY) === '1'
}

export function saveRoteiroCollapsed(collapsed: boolean): void {
  write(ROTEIRO_KEY, collapsed ? '1' : '0')
}

/** Padrão: maximizado. */
export function loadChatMinimized(): boolean {
  return read(CHAT_MIN_KEY) === '1'
}

export function saveChatMinimized(minimized: boolean): void {
  write(CHAT_MIN_KEY, minimized ? '1' : '0')
}
