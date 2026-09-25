// Tipos das contas Claude que atravessam o IPC. Nada aqui carrega token: o
// access/refresh token de uma conta nunca sai da pasta dela (CLAUDE_CONFIG_DIR).

/** Uma janela de limite do plano. `utilization` em 0–100; `resetsAt` em ms. */
export interface UsageWindow {
  utilization: number | null
  resetsAt: number | null
}

/** Última leitura de consumo de uma conta, com a hora em que foi feita. */
export interface AccountUsageReading {
  /** ms epoch da leitura. */
  at: number
  /** Chave = nome da janela (`five_hour`, `seven_day`, `seven_day_opus`, `model:fable`…). */
  windows: Record<string, UsageWindow>
}

/** Estado do login de uma conta, sem expor o token. */
export type ClaudeAccountStatus = 'connected' | 'expired' | 'logged-out'

/** O que a UI vê de uma conta. */
export interface ClaudeAccountView {
  id: string
  /** Apelido dado pelo usuário (vazio = mostrar o e-mail). */
  label: string
  email: string | null
  /** `max`, `pro`, `team`… como o CLI informa. */
  plan: string | null
  rateLimitTier: string | null
  status: ClaudeAccountStatus
  /** A conta que usa o login que já existia na máquina (~/.claude). */
  isDefault: boolean
  usage: AccountUsageReading | null
}

/** Resposta de "adicionar conta". */
export type AddClaudeAccountResult =
  | { ok: true; account: ClaudeAccountView }
  | { ok: false; reason: 'duplicate'; email: string }
  | { ok: false; reason: 'login-failed' | 'busy' }

/** Resposta da troca manual. `scheduled` = a conversa estava ocupada e a troca
 *  acontece ao terminar; `nextStart` = sem sessão aberta, vale no próximo início. */
export interface UseAccountResult {
  ok: boolean
  scheduled: boolean
  nextStart?: boolean
}

/** Consumo de uma conta para o painel e para a escolha de conta. */
export interface AccountUsageResult {
  accountId: string
  reading: AccountUsageReading | null
  /** false quando a consulta falhou e a leitura é a última guardada. */
  fresh: boolean
}
