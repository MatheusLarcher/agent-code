/**
 * Conversa vazia: a que nasceu de um "Nova conversa" e ainda não recebeu nada.
 * Fora do App.tsx para ser testável sem montar a janela.
 *
 * - Excluir uma vazia não pede confirmação: não há o que perder.
 * - "Nova conversa" numa pasta que já tem uma vazia volta para ela, em vez de
 *   deixar duas vazias lado a lado.
 *
 * O título entra na regra porque planejamento, handoff, MCP e conversa
 * renomeada nunca têm o padrão. O rascunho conta como conteúdo: o Composer o
 * grava na conversa no blur, então ele já chegou quando a lixeira é clicada.
 */
import { isPlanningConversation } from './planning/planningConversation'
import { DEFAULT_TITLE, type Conversation } from './types'

/** Sem mensagem, sem rascunho (texto ou anexo) e com o título de nascimento. */
export function isBlankConversation(c: Conversation): boolean {
  return (
    c.messages.length === 0 &&
    c.title === DEFAULT_TITLE &&
    !c.draft?.trim() &&
    !c.draftMedia?.length &&
    !isPlanningConversation(c)
  )
}

/** A conversa vazia da pasta `folder` para reaproveitar: a `preferId` (a ativa)
 *  se for uma delas, senão a primeira da lista. Nenhuma → undefined. */
export function findBlankConversation(
  list: readonly Conversation[],
  folder: string,
  preferId?: string | null
): Conversation | undefined {
  const blanks = list.filter((c) => c.cwd === folder && isBlankConversation(c))
  return blanks.find((c) => c.id === preferId) ?? blanks[0]
}
