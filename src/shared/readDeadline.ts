/**
 * Prazo das leituras de banco que a tela espera (preload → main). Estourado, a
 * promessa rejeita com esta marca na mensagem — a tela mostra o que já tem e
 * "tentar de novo" (renderer/deadline.ts). A consulta no main segue até o fim;
 * só a espera da tela é que acaba.
 */
export const READ_DEADLINE_MARK = '[agent-code-read-deadline]'

/** Leitura interativa comum: abrir conversa, painéis, quadro, históricos. */
export const READ_DEADLINE_MS = 2_000

/** Leituras de volume (a lista da abertura, os lotes de projetos, "mostrar mais"):
 *  payload de conversas inteiro — com o banco na nuvem são MB pela rede. */
export const BULK_READ_DEADLINE_MS = 20_000

/** Contagem exata do contexto: com a sessão viva é uma chamada à API, não ao banco. */
export const NETWORK_READ_DEADLINE_MS = 15_000

export function readDeadlineMessage(ms: number): string {
  return `${READ_DEADLINE_MARK} O banco não respondeu em ${Math.max(1, Math.round(ms / 1000))} s.`
}

export function isReadDeadlineMessage(message: unknown): boolean {
  return typeof message === 'string' && message.includes(READ_DEADLINE_MARK)
}
