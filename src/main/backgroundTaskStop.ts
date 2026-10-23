/**
 * Parar UMA tarefa de fundo (Bash em segundo plano, subagente em background) sem
 * tocar no turno nem nas outras tarefas: `Query.stopTask(taskId)` do SDK. A tela
 * do PC (IPC `agent:stop-task`) e o celular (`POST /api/stop-task`) passam pela
 * mesma validação e vão direto à sessão da conversa — parar uma tarefa não mexe
 * em estado de tela; a linha some quando o SDK manda a lista nova.
 */

/** Teto dos ids que chegam de fora (o mesmo das tarefas MCP). */
export const STOP_ID_MAX = 200

/** Id vindo do IPC ou do celular: texto não vazio, até 200 caracteres. */
export function validStopId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= STOP_ID_MAX
}

/** O corpo do `POST /api/stop-task`; null quando falta ou sobra algo. */
export function parseStopTaskBody(body: string | null): { convId: string; taskId: string } | null {
  let raw: unknown
  try {
    raw = JSON.parse(body ?? '')
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const { convId, taskId } = raw as { convId?: unknown; taskId?: unknown }
  return validStopId(convId) && validStopId(taskId) ? { convId, taskId } : null
}

/** O que a sessão da conversa precisa oferecer. */
export interface TaskStopper {
  stopTask(taskId: string): Promise<boolean>
}

/** Para a tarefa na sessão da conversa; ids inválidos ou sem sessão → false (nunca lança). */
export async function stopBackgroundTask(session: TaskStopper | undefined, convId: unknown, taskId: unknown): Promise<boolean> {
  if (!validStopId(convId) || !validStopId(taskId) || !session) return false
  try {
    return await session.stopTask(taskId)
  } catch {
    return false
  }
}
