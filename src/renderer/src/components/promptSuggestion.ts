/**
 * A sugestão do próximo prompt na tela do PC (evento `prompt-suggestion`): o mapa
 * conversa → sugestão do App e o texto que o chip põe no Composer.
 */

/** Texto posto no campo por quem monta o Composer (a sugestão do próximo prompt):
 *  entra a cada `nonce` novo, sem enviar. */
export interface ComposerInject {
  text: string
  nonce: number
}

/** Caixa vazia recebe o texto; com texto, ele entra no fim, depois de um espaço. */
export function appendInjected(current: string, add: string): string {
  return current.trim() ? `${current.replace(/\s+$/, '')} ${add}` : add
}

/** O mapa com a sugestão de `convId` trocada (ou tirada, com null); o mesmo objeto se nada mudou. */
export function withSuggestion(
  map: Readonly<Record<string, string>>,
  convId: string,
  text: string | null
): Readonly<Record<string, string>> {
  if (text) return map[convId] === text ? map : { ...map, [convId]: text }
  if (!(convId in map)) return map
  const next = { ...map }
  delete next[convId]
  return next
}
