/**
 * O pedaço do `window.api` (preload do PC) que as telas compartilhadas usam no
 * celular servido pela ponte. O código do PC confere cada função antes de
 * chamar; o que não está aqui fica sem (o painel que depende dele some ou cai no
 * que já tem):
 *
 *   officeAgentFile  modelos/animações do motor (`/api/office-agent`)
 *   downloadFile     "Baixar" do cartão de ferramenta e do chat (`/api/file`,
 *                    o mesmo download dos arquivos entregues do chat do celular)
 *   board*, tasks*, scrum*, handoffQueueEdit
 *                    o Quadro e o Scrum Master: os MESMOS canais IPC do PC,
 *                    repassados pelo POST /api/ipc (shared/remoteIpc.ts)
 *   onBoardChanged, onScrumChanged
 *                    os avisos do main, que chegam no SSE como `app-ipc`
 *
 * Como o `ipcRenderer.invoke`, a chamada que falha LANÇA (resposta `ok:false` da
 * ponte ou rede): quem usa no PC já trata com try/catch.
 *
 * Sem `readFile`: o `/api/file` só entrega arquivos criados pelo agente (APK,
 * PDF…), recusa código — o editor do monitor mostra os trechos das ferramentas.
 * Sem `projectDir`: "Todos os arquivos" some do Explorador. Sem `setConfig`: a
 * chave "Pode parar envios" do SM responde "Indisponível nesta versão.".
 */
import type { AgentCodeApi } from '@shared/api'
import { Channels } from '@shared/ipc'
import { isRemoteIpcEvent, type RemoteIpcChannel, type RemoteIpcEventChannel, type RemoteIpcResponse } from '@shared/remoteIpc'
import type { RemoteClient } from '../core/client'
import { triggerDownload } from '../core/download'
import { basename } from '../core/format'
import { HttpError, errorText, statusOf } from '../core/net'

type IpcKeys =
  | 'boardList'
  | 'boardDismiss'
  | 'boardMove'
  | 'boardItemEvents'
  | 'boardPrints'
  | 'boardPrintImage'
  | 'tasksBoard'
  | 'tasksDetail'
  | 'scrumPanel'
  | 'scrumHistory'
  | 'scrumChatHistory'
  | 'scrumAsk'
  | 'scrumDecideDeclaration'
  | 'handoffQueueEdit'
  | 'onBoardChanged'
  | 'onScrumChanged'

type BridgeApi = Pick<AgentCodeApi, 'officeAgentFile' | 'downloadFile' | IpcKeys>
type BridgeClient = Pick<RemoteClient, 'url' | 'fileUrl' | 'post' | 'eventTaps'>

/** O envelope SSE dos avisos do main (o mesmo do escritório). */
const OFFICE_CONV_ID = 'office'
/** O SM pensa antes de responder: a pergunta tem mais prazo que a leitura. */
const ASK_TIMEOUT_MS = 120_000

/** O texto da falha: o `error` da ponte quando houver; 404 sem ele = PC antigo, sem a rota. */
function failText(err: unknown): string {
  const body = err instanceof HttpError ? (err.body as Partial<RemoteIpcResponse> | null) : null
  if (body && body.ok === false && typeof body.error === 'string' && body.error) return body.error
  if (statusOf(err) === 404) return 'O app do PC não tem esta função. Atualize o agent-code no PC.'
  return errorText(err)
}

/** POST /api/ipc: devolve o `result` do handler do PC ou lança com o motivo. */
export async function invokeIpc<T>(client: Pick<RemoteClient, 'post'>, channel: RemoteIpcChannel, args: unknown[], timeout?: number): Promise<T> {
  let r: RemoteIpcResponse
  try {
    r = await client.post<RemoteIpcResponse>('/api/ipc', { channel, args }, timeout)
  } catch (err) {
    throw new Error(failText(err))
  }
  if (!r || r.ok !== true) throw new Error((r && 'error' in r && r.error) || 'O PC recusou o pedido.')
  return r.result as T
}

/** Assina um aviso do main; devolve o "desligar". */
export function onIpcEvent<T>(client: Pick<RemoteClient, 'eventTaps'>, channel: RemoteIpcEventChannel, cb: (payload: T) => void): () => void {
  const tap = (msg: { convId?: string; event?: unknown }): void => {
    if (msg.convId !== OFFICE_CONV_ID || !isRemoteIpcEvent(msg.event) || msg.event.channel !== channel) return
    cb(msg.event.payload as T)
  }
  client.eventTaps.add(tap)
  return () => {
    client.eventTaps.delete(tap)
  }
}

export function bridgeApi(client: BridgeClient): BridgeApi {
  const call = <T>(channel: RemoteIpcChannel, args: unknown[], timeout?: number): Promise<T> => invokeIpc<T>(client, channel, args, timeout)
  return {
    officeAgentFile: async (name) => {
      try {
        const res = await fetch(client.url(`/api/office-agent?name=${encodeURIComponent(name)}`))
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null
      } catch {
        return null
      }
    },
    downloadFile: async (path) => {
      if (!path) return { ok: false, message: 'Arquivo sem caminho.' }
      triggerDownload(client.fileUrl(path), path)
      return { ok: true, message: `Baixando ${basename(path)}…` }
    },
    boardList: (q) => call(Channels.boardList, [q]),
    boardDismiss: (id, dismissed) => call(Channels.boardDismiss, [id, dismissed]),
    boardMove: (id, toStatus) => call(Channels.boardMove, [id, toStatus]),
    boardItemEvents: (id) => call(Channels.boardItemEvents, [id]),
    boardPrints: (q) => call(Channels.boardPrints, [q]),
    boardPrintImage: (id) => call(Channels.boardPrintImage, [id]),
    tasksBoard: (q) => call(Channels.tasksBoard, [q ?? {}]),
    tasksDetail: (taskId) => call(Channels.tasksDetail, [taskId]),
    scrumPanel: () => call(Channels.scrumPanel, []),
    scrumHistory: (req) => call(Channels.scrumHistory, [req]),
    scrumChatHistory: (req) => call(Channels.scrumChatHistory, [req ?? {}]),
    scrumAsk: (req) => call(Channels.scrumAsk, [req], ASK_TIMEOUT_MS),
    scrumDecideDeclaration: (req) => call(Channels.scrumDecideDeclaration, [req]),
    handoffQueueEdit: (req) => call(Channels.handoffQueueEdit, [req]),
    onBoardChanged: (cb) => onIpcEvent(client, Channels.boardChanged, cb),
    onScrumChanged: (cb) => onIpcEvent(client, Channels.scrumChanged, cb)
  }
}

/** Liga a ponte no `window.api` sem apagar o que já houver (o que existe vence). */
export function installBridgeApi(client: BridgeClient): void {
  const w = window as unknown as { api?: Partial<AgentCodeApi> }
  w.api = { ...bridgeApi(client), ...(w.api ?? {}) }
}
