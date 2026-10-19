/**
 * O Quadro e o Scrum Master no celular: a ponte repassa ao main os MESMOS
 * canais IPC que a tela do PC usa (os handlers de `ipcMain`), só os desta
 * lista — nada de config, arquivo ou sessão.
 *
 *   celular → PC   POST /api/ipc  { channel, args }  →  { ok: true, result } | { ok: false, error }
 *   PC → celular   SSE no envelope dos chats ({ convId: OFFICE_BRIDGE_CONV, event }),
 *                  event = { kind: REMOTE_IPC_EVENT_KIND, channel, payload }
 *
 * O app do celular antigo ignora o evento (é "da outra conversa" do escritório).
 */
import { Channels } from './ipc'

/** Os canais que o celular pode chamar (invoke). */
export const REMOTE_IPC_INVOKE = [
  Channels.boardList,
  Channels.boardDismiss,
  Channels.boardMove,
  Channels.boardItemEvents,
  Channels.boardPrints,
  Channels.boardPrintImage,
  Channels.tasksBoard,
  Channels.tasksDetail,
  Channels.scrumPanel,
  Channels.scrumHistory,
  Channels.scrumChatHistory,
  Channels.scrumAsk,
  Channels.scrumDecideDeclaration,
  Channels.handoffQueueEdit,
  // Pausar/retomar/cancelar/visto da bolinha de tarefas (a lista vem no /api/state).
  Channels.tarefasAcao,
  // O token FCM do celular pareado (push com o app fechado; tarefas/destinoCelular.ts).
  Channels.celularPushToken
] as const

/** Os avisos do main que seguem para o celular (o `send` do main). */
export const REMOTE_IPC_EVENTS = [Channels.boardChanged, Channels.scrumChanged, Channels.tarefasChanged] as const

export type RemoteIpcChannel = (typeof REMOTE_IPC_INVOKE)[number]
export type RemoteIpcEventChannel = (typeof REMOTE_IPC_EVENTS)[number]

export const REMOTE_IPC_EVENT_KIND = 'app-ipc'
/** Teto de argumentos por chamada (nenhum canal da lista usa mais de 2). */
export const REMOTE_IPC_MAX_ARGS = 4

export interface RemoteIpcRequest {
  channel: RemoteIpcChannel
  args: unknown[]
}

export type RemoteIpcResponse = { ok: true; result: unknown } | { ok: false; error: string }

export interface RemoteIpcEvent {
  kind: typeof REMOTE_IPC_EVENT_KIND
  channel: RemoteIpcEventChannel
  payload: unknown
}

export function isRemoteIpcChannel(value: unknown): value is RemoteIpcChannel {
  return typeof value === 'string' && (REMOTE_IPC_INVOKE as readonly string[]).includes(value)
}

export function isRemoteIpcEventChannel(value: unknown): value is RemoteIpcEventChannel {
  return typeof value === 'string' && (REMOTE_IPC_EVENTS as readonly string[]).includes(value)
}

/** O corpo do POST /api/ipc, validado (null = inválido). */
export function parseRemoteIpcRequest(body: unknown): RemoteIpcRequest | null {
  if (!body || typeof body !== 'object') return null
  const { channel, args } = body as { channel?: unknown; args?: unknown }
  if (!isRemoteIpcChannel(channel)) return null
  const list = args === undefined ? [] : args
  if (!Array.isArray(list) || list.length > REMOTE_IPC_MAX_ARGS) return null
  return { channel, args: list }
}

export function isRemoteIpcEvent(value: unknown): value is RemoteIpcEvent {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<RemoteIpcEvent>
  return v.kind === REMOTE_IPC_EVENT_KIND && isRemoteIpcEventChannel(v.channel)
}
