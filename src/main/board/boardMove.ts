import type { BoardItem, BoardPoWrite, PersistenceRepository } from '../persistence/types'
import { BOARD_USER_MOVE_REASON_PREFIX, boardItemStatus, boardItemTitle, type BoardItemStatus } from '../../shared/ipc'

const MOVE_STATUS_LABEL: Record<BoardItemStatus, string> = {
  pending: 'a fazer',
  in_progress: 'fazendo',
  completed: 'concluído'
}

export interface BoardMoveDeps {
  repository(): PersistenceRepository | null
  sendToSession?(convId: string, text: string): Promise<boolean>
  interruptSession?(convId: string): Promise<boolean>
  /** A escrita do status pelo MESMO caminho do PO (`BoardService.applyPo`). */
  applyPo(input: BoardPoWrite): Promise<BoardItem | null>
}

/**
 * O drag-and-drop do usuário: além de gravar o novo status pelo MESMO
 * caminho do PO (`applyPo`, `actor: 'user'`), faz o quadro controlar o
 * agente de verdade:
 *
 * - destino "fazendo" e o cartão não estava lá: manda uma mensagem para o
 *   agente da conversa começar. Sem sessão viva (nunca iniciada nesta
 *   execução do processo), NADA é gravado — a UI mostra a mensagem e desfaz
 *   a posição do cartão.
 * - saindo de "fazendo" para qualquer outro destino: interrompe o turno de
 *   verdade.
 * - troca direta "a fazer" ↔ "concluído" (nenhum dos dois lados é
 *   "fazendo"): só grava.
 */
export async function moveBoardItem(
  deps: BoardMoveDeps,
  id: string,
  toStatus: BoardItemStatus
): Promise<{ ok: boolean; message?: string }> {
  const repository = deps.repository()
  if (!repository) return { ok: false, message: 'O quadro está indisponível agora.' }
  const current = await repository.getBoardItem(id)
  if (!current) return { ok: false, message: 'Cartão não encontrado.' }
  const fromStatus = boardItemStatus(current)
  if (fromStatus === toStatus) return { ok: true }
  const convId = current.conversationId

  if (toStatus === 'in_progress') {
    const sent =
      (await deps.sendToSession?.(convId, `Comece a trabalhar nesta tarefa: "${boardItemTitle(current)}"`)) ?? false
    if (!sent) {
      return {
        ok: false,
        message: 'Abra esta conversa e mande uma mensagem para o agente começar antes de mover pelo quadro.'
      }
    }
  } else if (fromStatus === 'in_progress') {
    await deps.interruptSession?.(convId)
  }

  const item = await deps.applyPo({
    id,
    poStatus: toStatus,
    poReason: `${BOARD_USER_MOVE_REASON_PREFIX} para "${MOVE_STATUS_LABEL[toStatus]}" pelo quadro`,
    actor: 'user'
  })
  return item ? { ok: true } : { ok: false, message: 'Não foi possível gravar a mudança no quadro.' }
}
