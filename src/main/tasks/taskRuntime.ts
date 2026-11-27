import type { TaskRepository } from '../persistence/types'
import { TaskLedger } from './taskLedger'
import type { TaskBoardPort } from './taskBoardSync'

/**
 * Handle único do registro de tarefas no processo, no mesmo molde de
 * `memoryRuntime`: o ciclo de vida do armazenamento publica aqui o repositório
 * ativo em toda transição de backend, para uma sessão nunca continuar gravando
 * num repositório substituído ou fora do ar.
 *
 * `null` enquanto não há repositório autoritativo. É por isso que a sessão só
 * registra o servidor MCP de tarefas quando isto não é nulo: sem banco, a
 * ferramenta aceitaria a tarefa e a perderia em silêncio.
 */
let ledger: TaskLedger | null = null
let board: TaskBoardPort | null = null

export function configureTaskRuntime(repository: TaskRepository | null): void {
  if (!repository) {
    ledger = null
    return
  }
  // Rebind em vez de recriar: quem já segurava a instância segue válido.
  if (ledger) ledger.bind(repository)
  else {
    ledger = new TaskLedger(repository)
    ledger.attachBoard(board)
  }
}

/**
 * O Quadro do processo, para as tarefas virarem cartões (`taskBoardSync.ts`).
 * Guardado à parte porque o ledger é recriado quando o banco volta do ar.
 */
export function configureTaskBoard(next: TaskBoardPort | null): void {
  board = next
  ledger?.attachBoard(next)
}

export function taskLedger(): TaskLedger | null {
  return ledger
}
