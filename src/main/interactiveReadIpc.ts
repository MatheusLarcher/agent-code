import { Channels } from '../shared/ipc'
import { interactiveRead } from './persistence/priorityPool'

/**
 * As leituras que a tela espera — conversas, quadro, tarefas, históricos,
 * memória, contexto — rodam na faixa interativa: as consultas delas vão às
 * conexões reservadas (persistence/priorityPool.ts) e nunca esperam atrás das
 * gravações de fundo (fila, telemetria, espelho, export).
 */
export const INTERACTIVE_READ_CHANNELS: ReadonlySet<string> = new Set([
  Channels.conversationsLoadVersioned,
  Channels.conversationsCountByProject,
  Channels.boardList,
  Channels.tasksBoard,
  Channels.tasksDetail,
  Channels.boardItemEvents,
  Channels.boardPrints,
  Channels.boardPrintImage,
  Channels.handoffList,
  Channels.handoffQueueList,
  Channels.handoffProjectStatus,
  Channels.tokenUsageHistory,
  Channels.turnTimeTotals,
  Channels.contextTurnsList,
  Channels.contextTurnsRead,
  Channels.contextTurnsCountExact,
  Channels.memoryListEntries,
  Channels.memoryReadEntry,
  Channels.memoryConflicts,
  Channels.outboxList,
  Channels.poAuthorizationList,
  Channels.projectColors
])

type Listener = (event: unknown, ...args: unknown[]) => unknown

/**
 * Liga a faixa interativa nos handlers desses canais, registrados por qualquer
 * módulo: chamar UMA vez, antes de qualquer `ipcMain.handle`.
 */
export function routeInteractiveReads(ipcMain: { handle(channel: string, listener: Listener): void }): void {
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel: string, listener: Listener): void => {
    if (!INTERACTIVE_READ_CHANNELS.has(channel)) return handle(channel, listener)
    return handle(channel, (event, ...args) => interactiveRead(async () => listener(event, ...args)))
  }
}
