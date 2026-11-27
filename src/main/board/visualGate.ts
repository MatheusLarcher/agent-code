/**
 * O lembrete da tela: o agente que edita arquivo de tela (.tsx, .css, .html…)
 * num turno em que ainda não olhou a tela recebe, junto do resultado da edição
 * (PostToolUse), o pedido de abrir e tirar um print antes de dizer "pronto".
 *
 * Por quê: numa conversa o usuário recusou 5 resultados de tela seguidos — todos
 * entregues sem o agente ter olhado. Mesmo molde do `planGate`: código, não
 * instrução; lembra UMA vez por turno; não vale para subagente nem fora de turno.
 */

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const UI_FILE = /\.(tsx|jsx|vue|svelte|css|scss|sass|less|html?)$/i
const IMAGE_FILE = /\.(png|jpe?g)$/i

/** Ferramentas que contam como "olhou a tela". */
const VISUAL_CHECK_TOOLS = new Set([
  'mcp__browser__browser_screenshot',
  'mcp__windows__windows_get_state',
  'mcp__android__android_screenshot',
  'mcp__chrome__chrome_screenshot',
  'mcp__app__app_anexar_print'
])

export interface VisualGateState {
  /** Já houve conferência visual neste turno. */
  checked: boolean
  /** O lembrete já saiu neste turno. */
  reminded: boolean
}

export function newVisualGateState(): VisualGateState {
  return { checked: false, reminded: false }
}

export const VISUAL_GATE_MESSAGE =
  'Você editou a tela. Antes de dizer que está pronto, abra-a e tire um print para conferir ' +
  '(browser_screenshot, windows_get_state, android_screenshot ou o app de teste) e anexe com app_anexar_print.'

function filePath(input: unknown): string {
  const p = (input as { file_path?: unknown } | null)?.file_path
  return typeof p === 'string' ? p : ''
}

/**
 * Chamado no PostToolUse de TODA ferramenta: marca a conferência visual e
 * devolve o lembrete para anexar à edição de tela, ou `null`. Muta `state`.
 */
export function visualGateReminder(
  state: VisualGateState,
  toolName: string,
  toolInput: unknown,
  options: { isSubagent: boolean; inTurn: boolean }
): string | null {
  if (options.isSubagent || !options.inTurn) return null
  if (VISUAL_CHECK_TOOLS.has(toolName) || (toolName === 'Read' && IMAGE_FILE.test(filePath(toolInput)))) {
    state.checked = true
    return null
  }
  if (state.checked || state.reminded) return null
  if (!WRITE_TOOLS.has(toolName) || !UI_FILE.test(filePath(toolInput))) return null
  state.reminded = true
  return VISUAL_GATE_MESSAGE
}

/** Turno novo: a conferência e o lembrete valem só dentro do turno. */
export function noteVisualTurn(state: VisualGateState): void {
  state.checked = false
  state.reminded = false
}
