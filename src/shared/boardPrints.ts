/**
 * Os PRINTS dos cartões do quadro (a tarefa visual que o agente testou), como
 * a tela os recebe: a miniatura já como data URL (JPEG pequeno) e o print
 * grande só quando alguém abre (`boardPrintImage`).
 */

export interface BoardPrintMeta {
  id: string
  boardItemId: string
  legenda: string | null
  createdAt: string
  width: number
  height: number
  /** data:image/jpeg;base64,… (320 px). */
  thumbUrl: string
}

/** Sem banco gravável: `available: false` — lista vazia diria "nenhum print", o que seria mentira. */
export interface BoardPrintsResult {
  available: boolean
  prints: BoardPrintMeta[]
}

export type BoardPrintImageResult =
  | { ok: true; id: string; url: string; legenda: string | null; createdAt: string; width: number; height: number }
  | { ok: false; message: string }

/** Os prints de cada cartão, do mais novo para o mais velho. */
export function printsByCard(prints: readonly BoardPrintMeta[]): Map<string, BoardPrintMeta[]> {
  const out = new Map<string, BoardPrintMeta[]>()
  for (const p of [...prints].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    out.set(p.boardItemId, [...(out.get(p.boardItemId) ?? []), p])
  }
  return out
}
