import { boardItemStatus, boardTurnEndReason, parseBoardTurnEndReason, type BoardItem } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { defaultCompletions, PO_DEFAULT_COMPLETE_REASON, untouchedSinceTurnEnd } from './poCloseDefault'
import { parsePoHold, type PoNextPrompt } from './poHold'
import type { PoAuthorization } from '../../shared/poAuthorization'
import { parsePoAuthorization, PO_ROUTINE_REASON, routineFor, type PoAuthorizationOp } from './poAuthorization'
import { linkLedgerTaskToCard, type PoLedgerDeps } from './poLedger'
import { shapePendencies } from './poPendency'
import { clamp, PO_AWAITING_AUTHORIZATION_REASON, type PoOrphanEtapa, type PoPhase } from './poPrompt'
import { parsePoVerdict, rejectUnsafeOps, type PoOp } from './poVerdict'
import { BOARD_USER_ACTION_MAX_CHARS } from '../board/boardUserAction'

/**
 * A escrita do veredito do PO no quadro: da resposta do modelo às operações
 * aplicadas. Sem estado e sem saber de fila, cooldown ou rota — isso é do
 * `Po` (po.ts). Aqui entra só o que a escrita consome: o quadro e as pontes com
 * o registro de tarefas (para o vínculo tarefa↔cartão).
 */
export interface PoApplyDeps extends PoLedgerDeps {
  board: Pick<BoardService, 'list' | 'applyPo' | 'createPoItem'>
  /** SEGURAR: o próximo prompt da fila espera, com o motivo (handoffQueueEdit.holdQueued). */
  holdNext?(envioId: string, motivo: string): Promise<void>
  /** AUTORIZAR/REVOGAR da abertura (a barreira "fila só com fila" mora em quem grava). */
  authorize?(convId: string, op: PoAuthorizationOp): Promise<void>
  /** A pendência de commit autorizada vira rotina na fila, com o texto fixo. */
  queueRoutine?(convId: string, routine: PoRoutineRequest): Promise<void>
  /** As etapas do prompt sem cartão, relidas antes de criar o cartão delas (ver `confirmOrphans`). */
  orphanEtapas?(convId: string): Promise<PoOrphanEtapa[]>
}

/** A rotina pedida pelo fechamento: o título do cartão de origem e onde ela roda. */
export interface PoRoutineRequest {
  title: string
  push: boolean
  cwd: string
  projectId: string
}

/** De quem é a análise que está escrevendo. */
export interface PoApplyTarget {
  convId: string
  cwd: string
  projectId: string
  phase: PoPhase
  /** O início da análise — a referência de tempo do vínculo tarefa↔cartão
   *  (ver `linkLedgerTaskToCard`). */
  startedAt: number
  /** Só no fechamento: os cartões da seção de devolvidos do digest. Os que o
   *  veredito não citou são concluídos pelo padrão (poCloseDefault.ts). */
  returned?: readonly BoardItem[]
  /** Só no fechamento: o próximo prompt que o digest mostrou — o único que o SEGURAR alcança. */
  next?: PoNextPrompt | null
  /** Só no fechamento: a autorização de commit/push da conversa (a pendência vira rotina). */
  authorization?: PoAuthorization | null
  /** Só no fechamento: as etapas do prompt sem cartão que o digest listou. */
  orphans?: readonly PoOrphanEtapa[]
}

/** O que já foi escrito. Mutável de propósito: se uma escrita lança no meio,
 *  quem chamou ainda anuncia e registra no diário o que chegou a ir. */
export interface PoApplyProgress {
  applied: number
  touched: string[]
}

/**
 * O que o usuário precisa fazer no cartão que a NOVA cria — só no que nasce "a
 * fazer". O VOCÊ do veredito vale; sem ele, a NOVA que espera autorização recebe
 * o padrão determinístico "Autorizar: <título>" (o título já completo pela
 * pendência), porque é exatamente isso que ela espera e o modelo esqueceu de dizer.
 */
export function poCreateUserAction(op: Extract<PoOp, { kind: 'create' }>): string | null {
  if (op.status !== 'pending') return null
  if (op.userAction) return op.userAction
  if (!op.reason.trim().toLowerCase().startsWith(PO_AWAITING_AUTHORIZATION_REASON)) return null
  return clamp(`Autorizar: ${op.title}`, BOARD_USER_ACTION_MAX_CHARS)
}

/** As operações que só podem ser escritas depois de conferidas contra o quadro
 *  de AGORA — ver `confirmCreates`. */
function needsFreshList(op: PoOp): boolean {
  // PENDENTE também: ele só vale para o cartão que ainda está (ou acabou de
  // voltar para) "a fazer" pelo fim do turno, e o usuário pode tê-lo concluído
  // no meio da consulta.
  return op.kind === 'create' || op.kind === 'start' || op.kind === 'justify'
}

/**
 * Relê o quadro imediatamente antes de escrever, quando há criação ou
 * ANDAMENTO.
 *
 * Entre o `list` que montou o digest e este ponto passou a consulta ao
 * modelo — segundos (às vezes quase um minuto) em que o quadro mudou por
 * outras mãos. Duas escritas daqui não podem ser feitas às cegas sobre isso:
 *
 * - Criar: a ABERTURA desta mesma conversa pode ter criado o cartão que o
 *   fechamento está prestes a criar de novo. Cartão duplicado fica no quadro e
 *   ninguém sabe qual seguir.
 * - ANDAMENTO: o cartão que o modelo viu "a fazer" pode ter sido concluído
 *   nesse meio-tempo — pelo CONCLUIR atrasado do fechamento anterior, pelo
 *   usuário no quadro, pelo agente. Aplicar reabriria um concluído por cima de
 *   uma decisão mais nova do que o próprio veredito.
 *
 * `board.settled` não cobre nenhum dos dois: ele é a fila de ingestão do
 * snapshot, e o PO (e o usuário) escrevem direto no repositório. Então as
 * barreiras são reaplicadas contra a lista FRESCA: a janela cai para o tempo de
 * um `list`, e o custo é uma leitura só quando há o que proteger — diferente de
 * esperar a outra fase terminar, que atrasaria toda auditoria e comeria a
 * janela que o quadro espera pelo PO. CONCLUIR e TITULO sozinhos não pagam a
 * leitura: nenhum deles rebaixa, e o CONCLUIR atrasado do fechamento tem que
 * valer por cima do "a fazer" do fim de turno. FEITA é criação (o parser a
 * devolve como `create` já concluído), então paga a leitura e passa pela
 * checagem de duplicata na lista fresca; sem lista fresca, é descartada.
 *
 * A fase segue para `rejectUnsafeOps`: é ela quem decide se um `create`
 * duplicado contra a lista fresca vira `start` (só faz sentido na abertura).
 */
export async function confirmCreates(deps: PoApplyDeps, ops: PoOp[], target: PoApplyTarget): Promise<PoOp[]> {
  if (!ops.some(needsFreshList)) return ops
  const fresh = await deps.board.list(target.cwd, { conversationId: target.convId })
  // Sem lista fresca não dá para afirmar que o cartão não existe, nem que ainda
  // está "a fazer". Falha fechada: duplicar ou reabrir é pior do que registrar
  // depois, e o que ficou de fora volta na próxima auditoria.
  if (!fresh) return ops.filter((op) => !needsFreshList(op))
  return confirmOrphans(deps, rejectUnsafeOps(ops, fresh, target.phase), target.convId)
}

/**
 * O cartão da etapa sem cartão só nasce se ela CONTINUA sem cartão pelo
 * casamento do acompanhamento, relido agora: o agente (ou outra conversa do
 * projeto) pode tê-lo criado durante a consulta, até com outro título — o que a
 * barreira de título não veria. Falha fechada, como a lista fresca: sem a
 * releitura, nenhum; a etapa volta no próximo fechamento.
 */
async function confirmOrphans(deps: PoApplyDeps, ops: PoOp[], convId: string): Promise<PoOp[]> {
  const etapaOf = (op: PoOp): string | null => (op.kind === 'create' ? op.etapaId ?? null : null)
  if (!ops.some((op) => etapaOf(op) !== null)) return ops
  const still = (await deps.orphanEtapas?.(convId).catch(() => null)) ?? []
  const ids = new Set(still.map((orphan) => orphan.etapaId.toLowerCase()))
  return ops.filter((op) => {
    const etapa = etapaOf(op)
    return etapa === null || ids.has(etapa)
  })
}

/**
 * Transforma a resposta do modelo em escritas no quadro. `cards` é a lista que
 * o modelo julgou (a de antes da consulta): é contra ela que os ids são
 * reconhecidos e a primeira barreira roda; `confirmCreates` confere de novo o
 * que precisa do quadro de agora.
 */
export async function applyPoVerdict(
  deps: PoApplyDeps,
  target: PoApplyTarget,
  text: string,
  cards: BoardItem[],
  progress: PoApplyProgress
): Promise<void> {
  const defaults = target.phase === 'close' ? defaultCompletions(text, target.returned ?? []) : []
  const orphanIds = (target.orphans ?? []).map((orphan) => orphan.etapaId)
  const parsed = parsePoVerdict(text, cards.map((card) => card.id), target.phase, orphanIds)
  const verdict = rejectUnsafeOps(shapePendencies(parsed, defaults, cards), cards, target.phase)
  const ops = await confirmCreates(deps, verdict, target)
  const { convId, cwd, projectId, startedAt } = target
  const byId = new Map(cards.map((card) => [card.id, card]))

  // O padrão ANTES das operações do veredito: um TITULO no mesmo cartão mudaria
  // a revisão que a guarda compara, e o cartão entregue voltaria para "a fazer".
  if (defaults.length > 0) {
    for (const card of defaults) {
      const written = await deps.board.applyPo({
        id: card.id,
        poStatus: 'completed',
        poReason: PO_DEFAULT_COMPLETE_REASON,
        onlyIf: untouchedSinceTurnEnd(card)
      })
      if (written && boardItemStatus(written) === 'completed' && written.poReason === PO_DEFAULT_COMPLETE_REASON) {
        progress.touched.push(card.id)
        progress.applied++
      }
    }
  }

  for (const op of ops) {
    if (op.kind === 'complete') {
      await deps.board.applyPo({ id: op.id, poStatus: 'completed', poReason: op.reason })
      progress.touched.push(op.id)
    } else if (op.kind === 'start') {
      await deps.board.applyPo({ id: op.id, poStatus: 'in_progress', poReason: op.reason })
      progress.touched.push(op.id)
      // O cartão acabou de entrar em andamento: tenta achar a tarefa do
      // registro que é este mesmo trabalho, para o quadro e o registro
      // apontarem para a mesma coisa sem depender de o agente lembrar.
      await linkLedgerTaskToCard(deps, convId, op.id, startedAt)
    } else if (op.kind === 'retitle') {
      // O motivo vai para `po_reason` — menos quando apagaria o motivo do fim
      // de turno, que sustenta o selo "Aguardando você" e a retomada: aí ele
      // fica só na linha do tempo. O cartão "em andamento" entra na exceção
      // porque o fim de turno pode rebaixá-lo entre a consulta e esta escrita
      // (a lista `cards` é a de antes da consulta).
      const card = byId.get(op.id)
      const keepReason = !card || boardItemStatus(card) === 'in_progress' || parseBoardTurnEndReason(card.poReason)
      await deps.board.applyPo(
        keepReason
          ? { id: op.id, poTitle: op.title, eventNote: op.reason }
          : { id: op.id, poTitle: op.title, poReason: op.reason }
      )
      progress.touched.push(op.id)
    } else if (op.kind === 'justify') {
      // Sem mudar o status: a frase fixa do fim de turno fica na frente (é ela
      // que o selo e a retomada reconhecem) e o motivo concreto vem depois. O
      // cartão ainda "em andamento" é o que o `result` vai devolver.
      // A ação do usuário é a DESTE PENDENTE: sem VOCÊ o cartão espera o agente,
      // e a ação de um PENDENTE anterior não pode ficar no cartão.
      const kind = parseBoardTurnEndReason(byId.get(op.id)?.poReason)?.kind ?? 'result'
      await deps.board.applyPo({
        id: op.id,
        poReason: boardTurnEndReason(kind, op.reason),
        userAction: op.userAction ?? null,
        eventNote: op.reason
      })
      progress.touched.push(op.id)
    } else {
      // Pendência de commit com autorização: não espera o usuário — vira rotina,
      // com o texto montado pelo código a partir do título do cartão de origem.
      const auth = target.phase === 'close' ? target.authorization : null
      const parent = op.parentId ? byId.get(op.parentId) : undefined
      const routine = !!auth && op.status === 'pending' && !!parent && routineFor(op.title, auth)
      // A rotina roda sozinha: não há o que o usuário fazer.
      const userAction = routine ? null : poCreateUserAction(op)
      const created = await deps.board.createPoItem({
        projectId,
        projectCwd: cwd,
        conversationId: convId,
        title: op.title,
        status: op.status,
        reason: routine ? PO_ROUTINE_REASON : op.reason,
        ...(op.parentId ? { parentId: op.parentId } : {}),
        ...(userAction ? { userAction } : {})
      })
      if (created) progress.touched.push(created.id)
      if (created && op.status === 'in_progress') await linkLedgerTaskToCard(deps, convId, created.id, startedAt)
      if (created && routine && auth && parent) {
        await deps.queueRoutine?.(convId, { title: parent.sourceTitle, push: auth.push, cwd, projectId })
      }
    }
    progress.applied++
  }

  // AUTORIZAR/REVOGAR: só a abertura lê a frase do usuário.
  const authOp = target.phase === 'open' ? parsePoAuthorization(text) : null
  if (authOp && deps.authorize) {
    await deps.authorize(convId, authOp)
    progress.applied++
  }

  // SEGURAR: só o próximo prompt que o digest mostrou, só no fechamento. O
  // envio que já saiu (o veredito atrasou e a fila andou) não é tocado.
  const hold = target.phase === 'close' && target.next ? parsePoHold(text) : null
  if (hold && target.next && deps.holdNext) {
    await deps.holdNext(target.next.envioId, hold)
    progress.applied++
  }
}
