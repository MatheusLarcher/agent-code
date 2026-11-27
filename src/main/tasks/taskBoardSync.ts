import type { BoardItemStatus } from '../../shared/ipc'
import type {
  BoardDismissBy,
  BoardPoCreate,
  BoardPoWrite,
  Task,
  TaskBoardLinkWrite,
  TaskRepository,
  TaskStatus
} from '../persistence/types'

/**
 * Espelha as tarefas do registro no Quadro. Sem isto, tarefa criada sem
 * `board_item_id` não ganhava cartão: o usuário via só os cartões antigos e
 * concluía que o time de agentes não tinha feito nada.
 *
 * Best-effort de ponta a ponta: o quadro nunca derruba a ferramenta nem o
 * reaper. A tarefa é a fonte da verdade; o cartão é a vitrine.
 */

/** O pedaço do `BoardService` que a sincronia usa (dublê simples nos testes). */
export interface TaskBoardPort {
  projectId(cwd: string): Promise<string>
  createPoItem(input: BoardPoCreate): Promise<{ id: string } | null>
  applyPo(input: BoardPoWrite): Promise<unknown>
  dismiss(id: string, dismissed: boolean, by?: BoardDismissBy): Promise<unknown>
}

export interface TaskBoardLinks {
  linkTaskToBoardItem(input: TaskBoardLinkWrite): Promise<void>
  boardItemIdsForTasks(taskIds: string[]): Promise<Map<string, string>>
}

/** Coluna do cartão para cada estado da tarefa; `null` = dispensar (cancelada). */
export function boardStatusForTask(status: TaskStatus): BoardItemStatus | null {
  switch (status) {
    case 'pending':
    case 'failed':
      return 'pending'
    case 'running':
    case 'review':
    case 'blocked':
      return 'in_progress'
    case 'done':
      return 'completed'
    case 'cancelled':
      return null
  }
}

const REASON_BY_STATUS: Record<TaskStatus, string> = {
  pending: 'tarefa de volta à fila',
  running: 'um agente começou a tarefa',
  review: 'tarefa em revisão',
  blocked: 'tarefa bloqueada',
  done: 'tarefa concluída',
  failed: 'tarefa falhou',
  cancelled: 'tarefa cancelada'
}

const HELD_STATUSES = (Object.keys(REASON_BY_STATUS) as TaskStatus[]).filter(
  (status) => boardStatusForTask(status) === 'in_progress'
)

/**
 * Os cartões que estão em "fazendo" porque uma tarefa do registro está em
 * andamento (running/review/blocked) — o fim de turno do Quadro
 * (`boardItemsToReopen`) não rebaixa esses: a coluna deles vem da tarefa.
 *
 * Lido do vínculo em `task_board_links`, não do texto do motivo: o PO ou o
 * usuário podem reescrever o motivo, e o cartão continua sendo da tarefa.
 * Olha `cwd` e as pastas equivalentes já gravadas sob `projectId` (outros PCs).
 */
export async function heldBoardItemIds(
  repository: Pick<TaskRepository, 'listTasks' | 'boardItemIdsForTasks' | 'projectCwdsForIdentity'>,
  cwd: string,
  projectId: string
): Promise<Set<string>> {
  const others = projectId ? await repository.projectCwdsForIdentity(projectId) : []
  const tasks = await repository.listTasks({ status: HELD_STATUSES, projectCwds: [...new Set([cwd, ...others])] })
  if (tasks.length === 0) return new Set()
  return new Set((await repository.boardItemIdsForTasks(tasks.map((task) => task.id))).values())
}

/** Cria o cartão da tarefa e o vincula. Devolve o id do cartão ou `null`. */
export async function createBoardCardForTask(
  board: TaskBoardPort,
  links: TaskBoardLinks,
  task: Task
): Promise<string | null> {
  try {
    const projectId = await board.projectId(task.projectCwd)
    if (!projectId) return null // pasta sem identidade: não há quadro onde pôr
    const card = await board.createPoItem({
      projectId,
      projectCwd: task.projectCwd,
      conversationId: task.conversationId ?? '',
      title: task.title,
      status: boardStatusForTask(task.status) ?? 'pending',
      reason: 'tarefa criada pelo time de agentes'
    })
    if (!card) return null
    await links.linkTaskToBoardItem({ taskId: task.id, boardItemId: card.id, linkedBy: 'agent' })
    return card.id
  } catch {
    return null
  }
}

/** Move o cartão vinculado (se houver) para a coluna do novo estado da tarefa. */
export async function syncBoardCardOnTransition(
  board: TaskBoardPort,
  links: TaskBoardLinks,
  task: Task,
  reason?: string
): Promise<void> {
  try {
    const cardId = (await links.boardItemIdsForTasks([task.id])).get(task.id)
    if (!cardId) return
    const base = REASON_BY_STATUS[task.status]
    const note = reason ? `${base}: ${reason}` : base
    const poStatus = boardStatusForTask(task.status)
    if (poStatus === null) {
      // O quadro não tem coluna de cancelado: dispensar tira o cartão da vista sem apagá-lo.
      await board.dismiss(cardId, true, { actor: 'system', note })
      return
    }
    await board.applyPo({ id: cardId, poStatus, poReason: note, actor: 'system' })
  } catch {
    /* best-effort: o cartão alcança na próxima transição */
  }
}
