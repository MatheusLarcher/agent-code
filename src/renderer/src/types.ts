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
  /** Set when this message's turn failed (LLM/session error). The message stays
   *  in the chat showing this error and a "Tentar de novo" button, so a typed
   *  message is never lost even when the model errors. */
  error?: string
  /** Set when the user manually canceled this message's turn — the chat shows a
   *  small "cancelada" note and the model is told to disregard it. */
  canceled?: boolean
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
  /** Reasoning effort for the model (low / medium / high / xhigh / max). */
  effort?: string
  /** Per-conversation "modo econômico" — when on, the LLM skips validation/build
   *  for trivial tasks to save tokens. Scoped to THIS conversation only. */
  economyMode?: boolean
  /** SDK session id captured from the agent, used to resume the conversation later. */
  sdkSessionId: string | null
  /** Unsent composer text for this conversation (draft). Kept across conversation
   *  switches and app restarts so a half-typed message is never lost. */
  draft?: string
  messages: UIMessage[]
  tokens: TokenTotals
  createdAt: number
  updatedAt: number
}

export const DEFAULT_TITLE = 'Nova conversa'
