/**
 * Sessão Claude expirada e o "Claude conectado?" do card "Conectar conta".
 *
 * O card só aparece com desconexão COMPROVADA: o CLI respondeu `loggedIn:false`
 * (sem conta extra conectada) ou um turno na conta da máquina falhou com erro
 * de autenticação real. Checagem que não respondeu (timeout, JSON inválido) não
 * é "desconectado". `claude auth status` diz `loggedIn:true` mesmo com o token
 * vencido, por isso a marca só sai com login bem-sucedido ou turno que deu certo.
 *
 * A marca vale para o login da máquina (conta padrão). Conta extra expirada já
 * aparece como `expired` no registro de contas.
 */
import type { ClaudeAuthStatus } from './auth'

let expired = false
let listener: (() => void) | null = null

function set(next: boolean): void {
  if (expired === next) return
  expired = next
  listener?.()
}

export const claudeAuthExpiry = {
  isExpired: (): boolean => expired,
  /** Turno falhou com erro de autenticação real. */
  markExpired: (): void => set(true),
  /** Login bem-sucedido ou turno concluído na conta da máquina. */
  clear: (): void => set(false),
  /** Chamado a cada mudança da marca (o index liga ao `providersChanged`). */
  onChange: (fn: (() => void) | null): void => {
    listener = fn
  }
}

/**
 * Mensagem `assistant` da thread principal que o CLI classificou como falha de
 * autenticação (`error: 'authentication_failed'` — "Please run /login", OAuth
 * expirado, API key inválida, 401). Cota, rede e limite de uso têm outros códigos
 * (`rate_limit`, `server_error`, `billing_error`...) e não contam.
 */
export function isClaudeAuthFailure(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const m = message as { type?: unknown; error?: unknown; parent_tool_use_id?: unknown }
  return m.type === 'assistant' && m.error === 'authentication_failed' && !m.parent_tool_use_id
}

/**
 * Claude conectado, para o card. `probe` devolve `null` quando a checagem foi
 * indeterminada; `extraConnected` diz se há conta extra conectada.
 */
export async function claudeConnectedForCard(deps: {
  probe: () => Promise<ClaudeAuthStatus | null>
  extraConnected: () => Promise<boolean>
}): Promise<boolean> {
  if (expired) return await deps.extraConnected()
  const status = await deps.probe()
  if (status === null || status.loggedIn) return true
  return await deps.extraConnected()
}
