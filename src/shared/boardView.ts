/**
 * A coluna CONCLUÍDO do quadro (painel 2D e quadro 3D) mostra só os 4
 * concluídos mais recentes, por `updatedAt`; o contador do cabeçalho segue com
 * o total. É só VISUAL: os outros continuam no banco, porque o dedupe do PO e o
 * casamento cartão↔etapa do acompanhamento leem só os não dispensados. Quem
 * apaga de verdade é o prazo de 2 dias (main/board/boardModel.ts).
 */

export const BOARD_COMPLETED_VISIBLE = 4

/** Os mais recentes primeiro, até `max`. */
export function recentCompleted<T extends { updatedAt: string }>(items: readonly T[], max = BOARD_COMPLETED_VISIBLE): T[] {
  const at = (item: T): number => {
    const ms = Date.parse(item.updatedAt)
    return Number.isFinite(ms) ? ms : 0
  }
  return [...items].sort((a, b) => at(b) - at(a)).slice(0, max)
}
