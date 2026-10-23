/**
 * A sugestão do próximo prompt do SDK (`promptSuggestions`): a mensagem
 * `prompt_suggestion` chega depois do `result` de um turno (do 2º em diante) com
 * o pedido provável do usuário. Vira o chip acima do composer, no PC e no
 * celular; o clique só põe o texto no campo, nunca envia.
 */

/** Acima disto não é um "próximo pedido": descarta em vez de cortar — um pedido
 *  cortado no meio vira outro pedido. */
export const PROMPT_SUGGESTION_MAX = 1000

/** O texto da sugestão, ou null quando a mensagem não traz um utilizável. */
export function promptSuggestionFrom(message: unknown): string | null {
  const raw = (message as { suggestion?: unknown } | null)?.suggestion
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  return text && text.length <= PROMPT_SUGGESTION_MAX ? text : null
}
