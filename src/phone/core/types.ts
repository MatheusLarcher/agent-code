/**
 * O que a ponte do PC (src/main/remote/remoteServer.ts) devolve ao celular. Os
 * tipos de cada conversa vêm de @shared — o contrato é o mesmo dos dois lados;
 * aqui só o recorte que o celular lê.
 */
import type { ChatEvent, RateLimitStatus, RemoteConversation, RemotePairedDevice } from '@shared/ipc'

/** Uma conversa no `/api/state` (sem a lista de mensagens). */
export type ConvSummary = Omit<RemoteConversation, 'messages'> & { messageCount?: number }

export interface ModelOption {
  id: string
  label: string
}

/** Corpo de `GET /api/state`. Tudo opcional além da lista: PCs antigos mandam menos campos. */
export interface StateResponse {
  conversations: ConvSummary[]
  voiceReady?: boolean
  skipPerms?: boolean
  models?: ModelOption[]
  modelEffort?: Record<string, string[]>
  effortLabels?: Record<string, string>
  usage?: Record<string, RateLimitStatus>
  projects?: string[]
  pairedDevice?: RemotePairedDevice | null
  relayState?: string
  /** Nome do PC (hostname do Windows): o nome padrão da filial no celular. PCs antigos não mandam. */
  pcName?: string
}

/** A mensagem do usuário como o PC guarda (UserMessage do renderer) mais o eco local do celular. */
export interface UserMsg {
  kind: 'user'
  id: string
  text: string
  images?: string[]
  files?: { name?: string; size?: number }[]
  canceled?: boolean
  injected?: boolean
  /** Eco local: ainda na fila do PC (a conversa estava ocupada). */
  queued?: boolean
  ts?: number
}

/** Uma mensagem do chat: evento do agente ou mensagem do usuário, com o resultado da ferramenta acoplado. */
export type ChatMsg = (ChatEvent | UserMsg) & {
  /** Todo item do feed tem id, menos alguns eventos de estado (ex.: `system`). */
  id?: string
  result?: { isError: boolean; text: string }
  answer?: boolean
  ts?: number
}

export type ToolUseMsg = Extract<ChatMsg, { kind: 'tool-use' }>

/** Envelope do SSE `/api/events`. */
export interface BridgeEvent {
  convId: string
  event: ChatEvent | { kind: string; [k: string]: unknown }
}

export interface ImageAttachment {
  mediaType: string
  data: string
}

export interface FileAttachment {
  name: string
  mediaType: string
  data: string
  size: number
}

export interface SearchResult {
  id: string
  title: string
  cwd: string
  snippet: string
  messageId: string | null
  updatedAt: number
}

/** Tipo de um aviso curto (toast): cada um com a sua cor — sucesso verde, erro vermelho, aviso amarelo. */
export type ToastTipo = 'sucesso' | 'erro' | 'aviso'
