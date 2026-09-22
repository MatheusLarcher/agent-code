/**
 * Espaço da Tela de Planejamento: largura do chat do Manager (arrastável) e o
 * roteiro recolhido. As duas escolhas valem entre sessões (localStorage —
 * síncrono, então a tela já abre do jeito que o usuário deixou).
 */

export const CHAT_DEFAULT_W = 380
export const CHAT_MIN_W = 320
/** O chat nunca passa da metade da área (roteiro + canvas + chat). */
export const CHAT_MAX_RATIO = 0.5
/** Passo das setas do teclado no divisor. */
export const CHAT_KEY_STEP = 16

const CHAT_W_KEY = 'agentcode.planning.chatWidth'
const ROTEIRO_KEY = 'agentcode.planning.roteiroCollapsed'

/** Maior largura do chat numa área de `containerWidth` (0 = ainda não medida). */
export function maxChatWidth(containerWidth: number): number {
  if (!(containerWidth > 0)) return Infinity
  return Math.max(CHAT_MIN_W, Math.floor(containerWidth * CHAT_MAX_RATIO))
}

/** Largura do chat dentro de [CHAT_MIN_W, metade da área]. */
export function clampChatWidth(width: number, containerWidth: number): number {
  const w = Number.isFinite(width) ? Math.round(width) : CHAT_DEFAULT_W
  return Math.min(Math.max(w, CHAT_MIN_W), maxChatWidth(containerWidth))
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

export function loadChatWidth(): number {
  const raw = read(CHAT_W_KEY)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? clampChatWidth(n, 0) : CHAT_DEFAULT_W
}

export function saveChatWidth(width: number): void {
  write(CHAT_W_KEY, String(Math.round(width)))
}

export function loadRoteiroCollapsed(): boolean {
  return read(ROTEIRO_KEY) === '1'
}

export function saveRoteiroCollapsed(collapsed: boolean): void {
  write(ROTEIRO_KEY, collapsed ? '1' : '0')
}
