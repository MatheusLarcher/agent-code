import { boardItemTitle, type BoardItem } from '../../shared/ipc'
import { clamp, PO_MAX_TITLE_CHARS } from './poPrompt'
import type { PoOp } from './poVerdict'

/**
 * A PENDÊNCIA que sobrou de um pedido entregue (commitar, verificar no app,
 * deploy) vira um cartão "a fazer" próprio, ligado ao cartão de onde sobrou e
 * com um título que diz QUAL tarefa — "Commitar a fase 1 do escritório", nunca
 * só "Commitar": no quadro, um "Commitar" solto não diz o que commitar.
 *
 * O vínculo vem do veredito (`NOVA <id do pedido> | ...`) ou, quando o modelo
 * não cita o id, da única conclusão do mesmo veredito (CONCLUIR explícito ou
 * pelo padrão): pendência é o que sobrou do pedido que acabou de ser entregue.
 * Com mais de uma conclusão, não há como saber de qual — fica sem pai.
 */

/** Título com menos palavras que isto não diz qual é a tarefa ("Commitar",
 *  "Fazer deploy"): ganha o título do cartão de origem. */
const MIN_TITLE_WORDS = 3

export function pendencyTitle(title: string, parent: BoardItem | undefined): string {
  const clean = title.trim()
  if (!parent || clean.split(/\s+/).filter(Boolean).length >= MIN_TITLE_WORDS) return clean
  return clamp(`${clean} — ${boardItemTitle(parent)}`, PO_MAX_TITLE_CHARS)
}

/**
 * Liga cada NOVA do fechamento ao cartão de origem e completa o título curto.
 * Roda ANTES das barreiras: a checagem de duplicata compara o título já
 * completo, igual ao do cartão que uma rodada anterior criou.
 */
export function shapePendencies(ops: PoOp[], defaults: readonly BoardItem[], cards: readonly BoardItem[]): PoOp[] {
  const concluded = new Set([...ops.flatMap((op) => (op.kind === 'complete' ? [op.id] : [])), ...defaults.map((card) => card.id)])
  const inferred = concluded.size === 1 ? [...concluded][0] : undefined
  const byId = new Map(cards.map((card) => [card.id, card]))
  return ops.map((op) => {
    if (op.kind !== 'create' || op.status !== 'pending') return op
    const parentId = op.parentId ?? inferred
    if (!parentId) return op
    return { ...op, parentId, title: pendencyTitle(op.title, byId.get(parentId)) }
  })
}
