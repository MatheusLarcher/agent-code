/**
 * Os prints dos cartões no banco (`board_item_prints`): a imagem comprimida, a
 * miniatura e os dados — nas duas persistências. Sem chave estrangeira para o
 * cartão, de propósito (como `handoff_entregas.board_item_id`): o agente pode
 * reescrever o plano e o cartão sumir; o print órfão sai na faxina.
 */

export interface BoardItemPrintRecord {
  id: string
  boardItemId: string
  projectId: string
  conversationId: string
  mime: string
  width: number
  height: number
  /** Tamanho da imagem grande (bytes). */
  bytes: number
  legenda: string | null
  createdAt: string
  thumb: Uint8Array
}

export interface BoardItemPrintWrite {
  id: string
  boardItemId: string
  projectId: string
  conversationId: string
  mime: string
  width: number
  height: number
  legenda: string | null
  createdAt: string
  data: Uint8Array
  thumb: Uint8Array
}

/** Por projeto (o ícone de câmera do quadro) ou por cartão (o detalhe). */
export interface BoardItemPrintQuery {
  projectId?: string
  boardItemId?: string
}

export interface BoardPrintRepository {
  /** Grava e apaga os mais velhos do cartão além de `keep`, na mesma escrita. */
  addBoardItemPrint(print: BoardItemPrintWrite, keep: number): Promise<void>
  /** Sem a imagem grande: miniatura e dados, do mais novo para o mais velho. */
  listBoardItemPrints(query: BoardItemPrintQuery): Promise<BoardItemPrintRecord[]>
  /** Com a imagem grande; null se não existe. */
  getBoardItemPrint(id: string): Promise<(BoardItemPrintRecord & { data: Uint8Array }) | null>
  /**
   * A faxina dos 30 dias: apaga o print feito antes de `cutoffIso` cujo cartão
   * está concluído desde antes dele (o reaberto guarda os prints) ou não existe
   * mais. Devolve quantos apagou.
   */
  pruneBoardItemPrints(cutoffIso: string): Promise<number>
}
