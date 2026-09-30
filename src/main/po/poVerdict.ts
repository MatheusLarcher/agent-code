import { boardItemStatus } from '../../shared/ipc'
import type { BoardItem, BoardItemStatus } from '../../shared/ipc'
import { clamp, PO_MAX_TITLE_CHARS, type PoPhase } from './poPrompt'
import { PO_MAX_OPS } from './poPromptText'

/**
 * A LEITURA do veredito do PO — o lado de volta de poPrompt.ts, que monta o
 * digest. Mora num arquivo próprio pelo teto de tamanho: o digest cresce a cada
 * fonte nova de evidência, e as barreiras daqui não podem ser o que o estoura.
 *
 * A seta é de mão única: este arquivo importa de poPrompt.ts, e poPrompt.ts não
 * importa (nem reexporta) nada daqui — quem precisa do veredito importa direto
 * de './poVerdict'. Assim não há ciclo, nem com valores avaliados no
 * carregamento do módulo.
 */

export type PoOp =
  | { kind: 'complete'; id: string; reason: string }
  /** ANDAMENTO: o pedido é coberto por um cartão que já existe. */
  | { kind: 'start'; id: string; reason: string }
  | { kind: 'retitle'; id: string; title: string }
  /** O status com que o cartão nasce: `in_progress` na abertura (o trabalho está
   *  começando), `pending` no fechamento (ficou faltando) e `completed` no
   *  FEITA (aconteceu neste turno e ninguém registrou). */
  | { kind: 'create'; title: string; reason: string; status: BoardItemStatus }

/**
 * Normalização de título para comparar dois cartões: NFD sem diacríticos,
 * minúsculas, espaços colapsados. É a mesma regra de busca acento-insensível do
 * resto do projeto, e aqui ela decide se um cartão novo é na verdade o cartão
 * que já está lá — "Corrigir a exportação" e "corrigir a exportacao" têm que
 * bater, senão o PO recria o mesmo cartão a cada turno.
 */
function normalizeTitle(text: string): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Lê a resposta do modelo.
 *
 * Falha FECHADA por linha: o que não casa com o formato é descartado em
 * silêncio, nunca vira uma operação inventada. Uma linha ruim não invalida as
 * outras — o contrário desperdiçaria uma análise inteira por um erro de
 * formatação.
 *
 * `knownIds` é a segunda barreira, e a que mais importa: uma operação sobre um
 * id que não está no quadro é descartada, então o PO não consegue mexer num
 * cartão que ele não viu.
 *
 * `phase` é a terceira: cada fase só aceita as operações que fazem sentido nela.
 * Um CONCLUIR numa análise de ABERTURA falaria de um trabalho que ainda nem
 * começou, e um ANDAMENTO no fechamento reabriria o que acabou de terminar —
 * nos dois casos o modelo respondeu a pergunta errada, e a resposta errada não
 * vira escrita. A fase cai em `close` quando não é informada: é o PO que já
 * existia antes da abertura.
 */
export function parsePoVerdict(raw: string, knownIds: Iterable<string>, phase: PoPhase = 'close'): PoOp[] {
  const ids = new Set(knownIds)
  const ops: PoOp[] = []
  const seen = new Set<string>()
  for (const line of (raw ?? '').split(/\r?\n/)) {
    if (ops.length >= PO_MAX_OPS) break
    const text = line.replace(/^[`\s>*-]+/, '').trim()
    if (!text || /^OK\b/i.test(text)) continue

    const complete = /^CONCLUIR\s+(\S+)\s*\|\s*(.+)$/i.exec(text)
    if (complete) {
      if (phase !== 'close') continue
      const [, id, reason] = complete
      if (!ids.has(id) || seen.has(`c:${id}`) || !reason.trim()) continue
      seen.add(`c:${id}`)
      ops.push({ kind: 'complete', id, reason: clamp(reason, 160) })
      continue
    }

    const start = /^ANDAMENTO\s+(\S+)\s*\|\s*(.+)$/i.exec(text)
    if (start) {
      if (phase !== 'open') continue
      const [, id, reason] = start
      if (!ids.has(id) || seen.has(`a:${id}`) || !reason.trim()) continue
      seen.add(`a:${id}`)
      ops.push({ kind: 'start', id, reason: clamp(reason, 160) })
      continue
    }

    const retitle = /^TITULO\s+(\S+)\s*\|\s*(.+)$/i.exec(text)
    if (retitle) {
      if (phase !== 'close') continue
      const [, id, title] = retitle
      if (!ids.has(id) || seen.has(`t:${id}`) || !title.trim()) continue
      seen.add(`t:${id}`)
      ops.push({ kind: 'retitle', id, title: clamp(title, PO_MAX_TITLE_CHARS) })
      continue
    }

    const create = /^(NOVA|FEITA)\s*\|\s*([^|]+)\|\s*(.+)$/i.exec(text)
    if (create) {
      const [, verb, title, reason] = create
      // FEITA é retroativo ("aconteceu neste turno"): só o fechamento tem turno
      // para olhar. Na abertura, o cartão nasce EM ANDAMENTO — o trabalho está
      // começando agora, não é uma intenção para depois nem coisa já feita.
      const done = verb.toUpperCase() === 'FEITA'
      if (done && phase !== 'close') continue
      if (!title.trim() || !reason.trim()) continue
      const clean = clamp(title, PO_MAX_TITLE_CHARS)
      const key = `n:${normalizeTitle(clean)}`
      if (seen.has(key)) continue
      seen.add(key)
      ops.push({
        kind: 'create',
        title: clean,
        reason: clamp(reason, 160),
        status: done ? 'completed' : phase === 'open' ? 'in_progress' : 'pending'
      })
    }
  }
  return ops
}

/**
 * Descarta (ou, num caso, TRANSFORMA) as operações que contrariam o esqueleto —
 * a última barreira antes do banco, e a que protege o invariante do recurso: o
 * PO corrige o que o agente esqueceu, não discute com o que o agente acabou de
 * dizer.
 *
 * A fase importa para um caso: um `create` rejeitado pelo dedupe de título, na
 * ABERTURA, contra um cartão existente que ainda está `pending`. Descartar em
 * silêncio perderia a intenção real do modelo ("isso está começando agora") —
 * e é exatamente essa perda que prende um cartão em "a fazer" enquanto o
 * trabalho de fato continua (o pedido virou uma continuação, "NOVA" colidiu
 * com o que já existe, e ninguém promoveu o cartão para `in_progress`). Em vez
 * de só rejeitar, convertemos em `start` no cartão colidido — uma garantia de
 * código, que não depende do modelo escolher a operação certa na próxima
 * rodada. No fechamento não existe ANDAMENTO, então a conversão não se aplica:
 * um `create`/`FEITA` duplicado ali continua simplesmente descartado, como
 * sempre foi.
 */
export function rejectUnsafeOps(ops: PoOp[], cards: BoardItem[], phase: PoPhase = 'close'): PoOp[] {
  const byId = new Map(cards.map((card) => [card.id, card]))
  // Os títulos que a conversa já tem, nas DUAS camadas: o cartão pode ter sido
  // renomeado pelo PO, e comparar só com o do agente deixaria passar a cópia.
  // `titleToCard` guarda o cartão por trás do título — só ele permite converter
  // um dedupe em `start`; um título que colide com outra operação desta MESMA
  // resposta (ainda sem cartão nenhum) não tem para onde converter.
  const titles = new Set<string>()
  const titleToCard = new Map<string, BoardItem>()
  for (const card of cards) {
    const sourceKey = normalizeTitle(card.sourceTitle)
    titles.add(sourceKey)
    titleToCard.set(sourceKey, card)
    if (card.poTitle) {
      const poKey = normalizeTitle(card.poTitle)
      titles.add(poKey)
      titleToCard.set(poKey, card)
    }
  }
  // Ids que já vão sair com `start` — seja porque o próprio modelo emitiu essa
  // operação nesta resposta, seja porque uma conversão anterior já a criou.
  // Sem isso, um segundo `create` duplicado para o mesmo cartão viraria um
  // segundo `start`, e `applyPo` seria chamado duas vezes à toa para o mesmo id.
  const startedIds = new Set(ops.filter((op) => op.kind === 'start').map((op) => op.id))

  const out: PoOp[] = []
  for (const op of ops) {
    if (op.kind === 'create') {
      // Sem esta barreira o PO recria o mesmo cartão a cada turno: ele não se
      // lembra do que criou ontem, e o quadro vira uma pilha de duplicatas que
      // ninguém sabe qual seguir. Um título só acrescenta trabalho ao quadro
      // quando ele é um trabalho NOVO.
      const title = normalizeTitle(op.title)
      if (!title) continue
      if (titles.has(title)) {
        const existing = titleToCard.get(title)
        if (
          phase === 'open' &&
          existing &&
          boardItemStatus(existing) === 'pending' &&
          !startedIds.has(existing.id)
        ) {
          startedIds.add(existing.id)
          out.push({ kind: 'start', id: existing.id, reason: op.reason })
        }
        continue
      }
      titles.add(title)
      out.push(op)
      continue
    }
    const card = byId.get(op.id)
    if (!card) continue
    if (op.kind === 'retitle') {
      if (op.title.trim() !== card.sourceTitle.trim()) out.push(op)
      continue
    }
    if (op.kind === 'start') {
      // Só entra em andamento o que ainda não começou: marcar de novo o que já
      // está em andamento é escrita à toa, e "reabrir" o que foi concluído é o
      // PO desfazendo um fato que o agente já registrou.
      if (boardItemStatus(card) === 'pending') out.push(op)
      continue
    }
    // Concluir: tudo o que ainda não está concluído.
    //
    // Uma versão anterior exigia `sourceStatus === 'pending'` aqui, e isso
    // matava o recurso: o caso central ("o agente fez e esqueceu de marcar")
    // deixa o cartão exatamente em `in_progress`, porque ele marcou o início e
    // não marcou o fim. O snapshot do CLI não tem noção de "agora" — e o PO só
    // roda com o turno JÁ encerrado, então "em andamento" ali é estado parado,
    // não trabalho acontecendo. Quem segura o exagero é o prompt (exige
    // evidência nas ações) e o motivo gravado no cartão, não uma proibição que
    // também barra o caso certo. A exceção — o trabalho que um subagente
    // continua fazendo em segundo plano — também fica com o prompt: o digest
    // lista o que ainda roda, e o CONCLUIR com prova de término continua válido.
    if (boardItemStatus(card) !== 'completed') out.push(op)
  }
  return out
}
