/**
 * Quais memórias entraram no prompt do agente, por conversa.
 *
 * O gate e o memorista precisam saber o que o agente JÁ tinha em mãos neste
 * turno: um fato que já estava injetado não vira memória nova, vira duplicata.
 * Quem escolhe as memórias é o seletor chamado pela sessão do agente
 * (`agentSession.ts`), e nada no evento de turno carrega essa escolha — daí o
 * registro aqui, no domínio de memória, e não um campo novo no `ChatEvent`:
 * isto é contexto de observador, não conteúdo de chat.
 *
 * Deliberadamente em memória e por conversa: é informação do turno corrente,
 * não vale nada amanhã e não pode sobreviver ao `dispose` da conversa.
 */

/** Teto por conversa. O seletor devolve no máximo 3 hoje; o teto existe para
 *  que um chamador errado não transforme isto num vazamento lento. */
const MAX_TRACKED = 16

const byConversation = new Map<string, readonly string[]>()

/** Registra as memórias injetadas no prompt desta conversa. Substitui: o que
 *  vale é a escolha do turno corrente, não o acumulado da conversa. */
export function recordUsedMemories(convId: string, relPaths: readonly string[]): void {
  if (!convId) return
  const unique = [...new Set(relPaths.filter((path) => typeof path === 'string' && path.trim().length > 0))]
  byConversation.set(convId, Object.freeze(unique.slice(0, MAX_TRACKED)))
}

/** O que foi injetado no prompt desta conversa. Vazio quando ninguém registrou. */
export function usedMemories(convId: string): readonly string[] {
  return byConversation.get(convId) ?? []
}

/** Conversa encerrada/excluída: some com o registro dela. */
export function forgetUsedMemories(convId: string): void {
  byConversation.delete(convId)
}
