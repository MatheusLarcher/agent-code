import type { ChatEvent } from '@shared/ipc'

/** A user message, rendered on the right side of the chat. */
export type UserMessage = {
  kind: 'user'
  id: string
  text: string
  /** Data-URL thumbnails of any attached images (for display only). */
  images?: string[]
  /** Non-image file attachments shown as cards in the bubble (display only). */
  files?: { name: string; size: number }[]
}

/** Anything the message list can render (agent events + user messages). */
export type UIMessage = (ChatEvent | UserMessage) & {
  result?: { isError: boolean; text: string }
  /** Set on the final assistant text of a turn (the actual answer, shown in full font). */
  answer?: boolean
  /** Epoch ms the turn finished — stamped on the answer so the chat can show
   *  when (and how long ago) that task ran. */
  ts?: number
}

/** Per-session token/cost accounting shown in the chat header. */
export interface TokenTotals {
  context: number
  output: number
  cost: number
}

/** A single conversation, grouped by its project folder (`cwd`) in the sidebar. */
export interface Conversation {
  id: string
  title: string
  /** Project folder the agent runs in. */
  cwd: string
  model: string
  /** SDK session id captured from the agent, used to resume the conversation later. */
  sdkSessionId: string | null
  messages: UIMessage[]
  tokens: TokenTotals
  createdAt: number
  updatedAt: number
}

export const DEFAULT_TITLE = 'Nova conversa'
