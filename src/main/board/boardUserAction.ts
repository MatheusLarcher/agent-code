import type { BoardPoWrite } from '../persistence/types'

/**
 * `po_user_action` — o que o USUÁRIO precisa fazer para o cartão "a fazer" andar
 * ("Escolher entre A e B", "Autorizar o deploy na VPS"). A regra mora aqui, e não
 * no SQL de cada repositório, pelo mesmo motivo de boardModel.ts: SQLite e
 * PostgreSQL decidem a MESMA coisa, ou o quadro diverge conforme o PC.
 */

/** Teto do texto gravado: uma ação imperativa curta, não um relatório. O PO lê
 *  o veredito com o mesmo teto; aqui é a barreira de quem grava. */
export const BOARD_USER_ACTION_MAX_CHARS = 120

/** O texto limpo para gravar: espaços colapsados e cortado no teto; vazio é `null`. */
export function boardUserActionText(value: string | null | undefined): string | null {
  const clean = (typeof value === 'string' ? value : '').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return clean.length > BOARD_USER_ACTION_MAX_CHARS ? `${clean.slice(0, BOARD_USER_ACTION_MAX_CHARS - 1)}…` : clean
}

/**
 * O valor depois de uma escrita do PO. O pedido explícito vale (`null` limpa).
 * Sem ele, TROCAR o status limpa: a ação era do "a fazer" que acabou de ser
 * substituído — CONCLUIR, a conclusão padrão, ANDAMENTO, a retomada, o arrasto do
 * usuário e o "Fala, PO" gravam status sem saber deste campo, e nenhum deles pode
 * deixar uma ação velha pendurada no cartão. Quem rebaixa e quer manter (o fim de
 * turno, que já mantém a justificativa do PENDENTE) passa o valor atual.
 */
export function nextBoardUserAction(
  input: Pick<BoardPoWrite, 'poStatus' | 'userAction'>,
  current: string | null
): string | null {
  if (input.userAction !== undefined) return boardUserActionText(input.userAction)
  return input.poStatus !== undefined ? null : current
}
