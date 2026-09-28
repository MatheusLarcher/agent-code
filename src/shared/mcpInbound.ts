/** Modelo fixo das tarefas do MCP de entrada, "por enquanto" (decisão do
 *  usuário). Um lugar só: o main força este modelo na sessão e a tela cria a
 *  conversa com ele. */
export const MCP_TASK_MODEL = 'claude-opus-5-5'

/**
 * Regra 1 do MCP de entrada: um envio que leva o id de uma tarefa que não está
 * viva (terminou, foi cancelada, deu erro, ou o app reiniciou e o registro —
 * só em memória — não a conhece) é RECUSADO pelo main, nunca vira mensagem do
 * usuário. O erro do `agent:send` leva esta marca; é por ela que a tela sabe
 * que tem de tirar o item da fila e avisar, em vez de marcar erro com "Tentar
 * de novo".
 */
export const MCP_TASK_GONE_MARK = '[tarefa-mcp-encerrada]'

/** O aviso da tela quando o main recusa pela regra 1. */
export const MCP_TASK_GONE_WARNING = 'Tarefa do Forgia já encerrada: ela saiu da fila e não foi enviada. O Forgia pode reenviar.'

/**
 * `agent:send` sem sessão viva na conversa (descartada, trocada ou com o lease
 * perdido durante o envio): nada foi enviado. A tela reconhece a marca para
 * marcar a conversa como desconectada — o "Tentar de novo" reconecta antes.
 */
export const NO_LIVE_SESSION_MARK = '[sem-sessao-viva]'
export const NO_LIVE_SESSION = `${NO_LIVE_SESSION_MARK} A conversa não tem sessão ativa (ela foi encerrada ou trocada durante o envio). Nada foi enviado: reconecte e envie de novo.`

/** O erro do `agent:send` é o de conversa sem sessão viva? */
export function isNoLiveSession(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return text.includes(NO_LIVE_SESSION_MARK)
}

/** "Continuar na conta X" no turno de uma tarefa MCP que já terminou em erro:
 *  recusado como a retomada automática (regra 2). */
export const MCP_NO_CONTINUE_WARNING =
  'O turno era de uma tarefa do Forgia que já terminou em erro: o Agent Code não a continua sozinho. O Forgia pode reenviar.'

/** O erro (do IPC, ou o `reason` do "agora") é a recusa da regra 1? */
export function isMcpTaskGone(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '')
  return text.includes(MCP_TASK_GONE_MARK)
}
