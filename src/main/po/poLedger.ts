import { taskLedger } from '../tasks/taskRuntime'
import { PO_MAX_LEDGER_TASKS, type PoLedgerTask } from './poPrompt'

/**
 * A ponte do PO com o registro de tarefas (mcp__tasks): a evidência extra do
 * digest e o vínculo automático tarefa↔cartão. Tudo aqui é tolerante a falha
 * de propósito — o registro é conveniência, não fonte da verdade, então sem
 * ele (ou com ele falhando) o PO degrada, nunca quebra.
 */

/** Uma tarefa do registro, reduzida ao que a heurística de vínculo precisa. */
export interface PoLinkableTask {
  id: string
  status: string
  createdAt: string
}

/** As pontes injetáveis com o registro — parte de `PoDeps`. */
export interface PoLedgerDeps {
  /**
   * As tarefas do registro (mcp__tasks) ligadas a esta conversa — evidência
   * que sobrevive ao teto de PO_MAX_CALLS porque não depende do histórico de
   * ações. Sem injeção (produção), consulta o registro ativo; sem registro,
   * ou se a consulta falhar, devolve vazio — o PO nunca quebra por causa
   * disso, só perde a seção extra do digest.
   */
  listConvTasks?(convId: string): Promise<PoLedgerTask[]>
  /**
   * Todas as tarefas do registro (mcp__tasks) desta conversa, para a heurística
   * de vínculo automático tarefa↔cartão — sem filtro de status ou data, quem
   * filtra é o PO (`linkLedgerTaskToCard`; assim o teste exercita a regra real,
   * não uma cópia dela no dublê). Mesmo contrato de tolerância a falha de
   * `listConvTasks`: sem injeção consulta o registro ativo, e sem registro ou
   * com a consulta falhando devolve vazio — nunca quebra o PO.
   */
  linkableLedgerTasks?(convId: string): Promise<PoLinkableTask[]>
  /** `task_id -> board_item_id` já vinculados, para não vincular de novo.
   *  Mesmo contrato de tolerância a falha das outras pontes com o registro. */
  linkedBoardItemsFor?(taskIds: string[]): Promise<Map<string, string>>
  /** Vincula (upsert) uma tarefa do registro a um cartão do quadro. Mesmo
   *  contrato de tolerância a falha das outras pontes com o registro. */
  linkTaskToBoardItem?(taskId: string, boardItemId: string): Promise<void>
}

/** Consulta o registro de tarefas ativo. Nunca lança: sem registro ou com a
 *  consulta falhando, o PO segue só com a evidência de ações — degrada, não
 *  quebra. */
export async function listConvTasks(deps: PoLedgerDeps, convId: string): Promise<PoLedgerTask[]> {
  // O catch cobre as DUAS origens (a injetada e o registro real): uma
  // consulta injetada em produção pode falhar tanto quanto o registro em
  // si, e das duas formas o PO segue só sem a seção extra, nunca aborta.
  try {
    if (deps.listConvTasks) return await deps.listConvTasks(convId)
    const ledger = taskLedger()
    if (!ledger) return []
    const tasks = await ledger.listTasks({ conversationId: convId, limit: PO_MAX_LEDGER_TASKS })
    return tasks.map((task) => ({ title: task.title, status: task.status }))
  } catch {
    return []
  }
}

/** Todas as tarefas do registro desta conversa, sem filtro — quem filtra é
 *  `linkLedgerTaskToCard`. Nunca lança: mesma tolerância de `listConvTasks`. */
async function linkableLedgerTasks(deps: PoLedgerDeps, convId: string): Promise<PoLinkableTask[]> {
  try {
    if (deps.linkableLedgerTasks) return await deps.linkableLedgerTasks(convId)
    const ledger = taskLedger()
    if (!ledger) return []
    const tasks = await ledger.listTasks({ conversationId: convId })
    return tasks.map((task) => ({ id: task.id, status: task.status, createdAt: task.createdAt }))
  } catch {
    return []
  }
}

/** `task_id -> board_item_id` já vinculados dentre os candidatos. Nunca lança. */
async function linkedBoardItemsFor(deps: PoLedgerDeps, taskIds: string[]): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map()
  try {
    if (deps.linkedBoardItemsFor) return await deps.linkedBoardItemsFor(taskIds)
    const ledger = taskLedger()
    if (!ledger) return new Map()
    return await ledger.boardItemIdsForTasks(taskIds)
  } catch {
    return new Map()
  }
}

/** Grava o vínculo. Nunca lança: um vínculo perdido não é motivo para
 *  derrubar a análise que já escreveu o cartão no quadro. */
async function linkTaskToBoardCard(deps: PoLedgerDeps, taskId: string, boardItemId: string): Promise<void> {
  try {
    if (deps.linkTaskToBoardItem) {
      await deps.linkTaskToBoardItem(taskId, boardItemId)
      return
    }
    const ledger = taskLedger()
    if (!ledger) return
    await ledger.linkTaskToBoardItem({ taskId, boardItemId, linkedBy: 'po' })
  } catch {
    // O vínculo é conveniência, não fonte da verdade: falhar aqui não pode
    // derrubar a auditoria que já promoveu o cartão.
  }
}

/**
 * Tenta vincular uma tarefa do registro ao cartão que ACABOU de entrar em
 * andamento nesta mesma conversa.
 *
 * Critério deliberadamente conservador: só vincula quando sobra EXATAMENTE
 * UMA candidata. Zero candidatas é "nada para vincular ainda"; mais de uma é
 * "não dá para saber qual" — nos dois casos, não vincular é o correto, porque
 * um vínculo errado é pior do que nenhum (o `critico` julgaria a tarefa
 * errada pelo cartão errado).
 *
 * `promotedAt` é o instante em que ESTA análise decidiu promover o cartão —
 * não existe, no que chega até aqui, um timestamp mais preciso do próprio
 * evento de promoção (o quadro guarda o cartão, não o "quando" da escrita do
 * PO). Usar o início da análise como aproximação é seguro na direção que
 * importa: uma tarefa aberta antes deste turno nunca é candidata, mesmo que
 * o registro e o quadro tenham relógios levemente diferentes.
 */
export async function linkLedgerTaskToCard(
  deps: PoLedgerDeps,
  convId: string,
  boardItemId: string,
  promotedAt: number
): Promise<void> {
  try {
    const tasks = await linkableLedgerTasks(deps, convId)
    const candidates = tasks.filter(
      (task) =>
        (task.status === 'running' || task.status === 'pending' || task.status === 'review') &&
        Date.parse(task.createdAt) > promotedAt
    )
    if (candidates.length === 0) return
    const linked = await linkedBoardItemsFor(deps, candidates.map((task) => task.id))
    const unlinked = candidates.filter((task) => !linked.has(task.id))
    if (unlinked.length !== 1) return
    await linkTaskToBoardCard(deps, unlinked[0].id, boardItemId)
  } catch {
    // Best-effort: o vínculo nunca deve derrubar a auditoria do PO.
  }
}
