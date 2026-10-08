import { boardItemStatus, boardItemTurnEndKind } from '../../shared/ipc'
import type { BoardItem, BoardItemStatus } from '../../shared/ipc'
import { BOARD_USER_ACTION_MAX_CHARS } from '../board/boardUserAction'
import { etapaIdFromTitle } from '../handoffTracking/handoffCardMatch'
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
  /** TITULO: título novo SEMPRE com motivo — toda alteração do PO se justifica. */
  | { kind: 'retitle'; id: string; title: string; reason: string }
  /** PENDENTE: o que faltou no cartão que o fim do turno devolve para "a
   *  fazer". Não muda o status — só troca a frase genérica pelo motivo real.
   *  `userAction`: o campo VOCÊ (ver `splitUserAction`); ausente, o cartão espera o agente. */
  | { kind: 'justify'; id: string; reason: string; userAction?: string }
  /** O status com que o cartão nasce: `in_progress` na abertura (o trabalho está
   *  começando), `pending` no fechamento (ficou faltando) e `completed` no
   *  FEITA (aconteceu neste turno e ninguém registrou). `parentId`: a NOVA do
   *  fechamento que cita o cartão de onde a pendência sobrou. `userAction`: o
   *  campo VOCÊ, só na que nasce "a fazer". `etapaId`: a etapa do prompt sem
   *  cartão que este cartão resolve (o `[id]` do título, em minúsculas). */
  | {
      kind: 'create'
      title: string
      reason: string
      status: BoardItemStatus
      parentId?: string
      userAction?: string
      etapaId?: string
    }

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

/** `NOVA|FEITA [<id de origem>] | <título> | <motivo>`. */
const CREATE_LINE = /^(NOVA|FEITA)(?:\s+([^\s|]+))?\s*\|\s*([^|]+)\|\s*(.+)$/i

/**
 * Separa o campo opcional `| VOCÊ: <ação>` — o que o USUÁRIO precisa fazer para
 * o cartão andar — do resto da linha. Sai ANTES das regras de cada operação: o
 * último campo do PENDENTE e da NOVA é `(.+)`, que engoliria a ação no motivo.
 * Marcador VOCÊ:/VOCE: sem diferenciar caixa, e só como campo próprio (depois de
 * um `|`): "esperando você escolher" no meio do motivo não é o marcador. A ação
 * vai até o fim da linha e é cortada no teto que o quadro grava.
 */
function splitUserAction(text: string): { body: string; userAction?: string } {
  const marker = /\|\s*VOC[EÊ]\s*:/i.exec(text)
  if (!marker) return { body: text }
  const action = clamp(text.slice(marker.index + marker[0].length), BOARD_USER_ACTION_MAX_CHARS)
  return { body: text.slice(0, marker.index).trim(), ...(action ? { userAction: action } : {}) }
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
 *
 * `orphanEtapas`: os ids das etapas do prompt sem cartão que o digest listou
 * (só no fechamento). A FEITA/NOVA com o prefixo `[id]` de uma delas leva o
 * `etapaId`, vale uma por etapa e fica FORA do teto de operações — a lista é
 * do app, não invenção do modelo, e cortar uma etapa a deixaria sem cartão.
 */
export function parsePoVerdict(
  raw: string,
  knownIds: Iterable<string>,
  phase: PoPhase = 'close',
  orphanEtapas: Iterable<string> = []
): PoOp[] {
  const ids = new Set(knownIds)
  const etapas = new Set(phase === 'close' ? [...orphanEtapas].map((id) => id.toLowerCase()) : [])
  const ops: PoOp[] = []
  const seen = new Set<string>()
  let exempt = 0
  for (const line of (raw ?? '').split(/\r?\n/)) {
    const full = ops.length - exempt >= PO_MAX_OPS
    if (full && etapas.size === 0) break
    const clean = line.replace(/^[`\s>*-]+/, '').trim()
    if (!clean || /^OK\b/i.test(clean)) continue
    // O VOCÊ sai de toda linha (num CONCLUIR ele só sujaria o motivo), mas só
    // o PENDENTE e a NOVA que nasce "a fazer" o guardam.
    const { body: text, userAction } = splitUserAction(clean)
    const create = CREATE_LINE.exec(text)
    const prefix = create ? etapaIdFromTitle(create[3]) : null
    const orphan = prefix !== null && etapas.has(prefix) ? prefix : null
    if (full && !orphan) continue

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

    // `TITULO <id> | <título>` sem motivo não casa com nada abaixo e cai fora:
    // título trocado sem justificativa é exatamente o que não pode mais passar.
    const retitle = /^TITULO\s+(\S+)\s*\|\s*([^|]+)\|\s*(.+)$/i.exec(text)
    if (retitle) {
      if (phase !== 'close') continue
      const [, id, title, reason] = retitle
      if (!ids.has(id) || seen.has(`t:${id}`) || !title.trim() || !reason.trim()) continue
      seen.add(`t:${id}`)
      ops.push({ kind: 'retitle', id, title: clamp(title, PO_MAX_TITLE_CHARS), reason: clamp(reason, 160) })
      continue
    }

    const justify = /^PENDENTE\s+(\S+)\s*\|\s*(.+)$/i.exec(text)
    if (justify) {
      if (phase !== 'close') continue
      const [, id, reason] = justify
      if (!ids.has(id) || seen.has(`p:${id}`) || !reason.trim()) continue
      seen.add(`p:${id}`)
      ops.push({ kind: 'justify', id, reason: clamp(reason, 160), ...(userAction ? { userAction } : {}) })
      continue
    }

    // `NOVA <id> | ...`: o id (opcional) é o cartão de ORIGEM da pendência. Só
    // vale na NOVA do fechamento e com um id do quadro; fora disso é ignorado,
    // e a linha continua valendo como NOVA comum.
    if (create) {
      const [, verb, origin, title, reason] = create
      // FEITA é retroativo ("aconteceu neste turno"): só o fechamento tem turno
      // para olhar. Na abertura, o cartão nasce EM ANDAMENTO — o trabalho está
      // começando agora, não é uma intenção para depois nem coisa já feita.
      const done = verb.toUpperCase() === 'FEITA'
      if (done && phase !== 'close') continue
      if (!title.trim() || !reason.trim()) continue
      if (orphan && seen.has(`e:${orphan}`)) continue
      // O corte guarda o começo: o prefixo `[id]` da etapa fica no título.
      const cleanTitle = clamp(title, PO_MAX_TITLE_CHARS)
      const key = `n:${normalizeTitle(cleanTitle)}`
      if (seen.has(key)) continue
      seen.add(key)
      if (orphan) {
        seen.add(`e:${orphan}`)
        exempt++
      }
      // A etapa do prompt não é pendência de outro cartão: sem pai.
      const parentId = !done && !orphan && phase === 'close' && origin && ids.has(origin) ? origin : undefined
      const status: BoardItemStatus = done ? 'completed' : phase === 'open' ? 'in_progress' : 'pending'
      ops.push({
        kind: 'create',
        title: cleanTitle,
        reason: clamp(reason, 160),
        status,
        ...(parentId ? { parentId } : {}),
        ...(userAction && status === 'pending' ? { userAction } : {}),
        ...(orphan ? { etapaId: orphan } : {})
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
  const concluded = new Set(ops.filter((op) => op.kind === 'complete').map((op) => op.id))
  /** Os títulos que ESTA resposta já cria. */
  const created = new Set<string>()

  const out: PoOp[] = []
  for (const op of ops) {
    if (op.kind === 'create') {
      // Sem esta barreira o PO recria o mesmo cartão a cada turno: ele não se
      // lembra do que criou ontem, e o quadro vira uma pilha de duplicatas que
      // ninguém sabe qual seguir. Um título só acrescenta trabalho ao quadro
      // quando ele é um trabalho NOVO.
      const title = normalizeTitle(op.title)
      if (!title) continue
      // A etapa do prompt sem cartão: quem disse que nenhum cartão fala por ela
      // foi o casamento do acompanhamento — o de título igual ficou de fora
      // dele (outro plano, pela trava de época) — e quem reconfere contra o
      // quadro de agora é `confirmCreates`. Aqui, só a cópia na mesma resposta.
      if (op.etapaId ? created.has(title) : titles.has(title)) {
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
      created.add(title)
      out.push(op)
      continue
    }
    const card = byId.get(op.id)
    if (!card) continue
    if (op.kind === 'retitle') {
      if (op.title.trim() !== card.sourceTitle.trim()) out.push(op)
      continue
    }
    if (op.kind === 'justify') {
      // Só se justifica o que o fim do turno devolve (ainda "em andamento") ou
      // já devolveu (o veredito atrasado) para "a fazer". E CONCLUIR na mesma
      // resposta vence: o cartão não volta, então não há o que justificar.
      if (concluded.has(op.id)) continue
      if (boardItemStatus(card) === 'in_progress' || boardItemTurnEndKind(card) !== null) out.push(op)
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
