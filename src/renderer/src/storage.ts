import type { Conversation } from './types'
import type { UIMessage } from './types'
import type { RateLimitStatus } from '@shared/ipc'

// Persistence for the conversation history + UI state. Now backed by the
// per-user SQLite store in the chosen cache folder (main process, via
// window.api.kvGet/kvSet), not localStorage. The agent's own transcript is also
// stored by the SDK under ~/.claude/projects (used for `resume`); this keeps the
// rendered history + sidebar metadata across restarts.
//
// Migration: the first time a key is missing from SQLite, any value still in the
// old localStorage is copied over (and kept as a harmless backup).

const CONV_KEY = 'agentcode.conversations.v1'
const UI_KEY = 'agentcode.ui.v1'
const USAGE_LIMITS_KEY = 'agentcode.usage-limits.v1'

export interface UiState {
  collapsed: boolean
  activeId: string | null
  /** Whether the embedded browser panel is minimized. */
  browserMinimized: boolean
  /** Width (CSS px) of the browser panel, set by dragging the splitter. */
  browserWidth: number
}

const DEFAULT_BROWSER_WIDTH = 720
const COMPACTION_AGE_MS = 15 * 24 * 60 * 60 * 1000

/** Keep only the useful narrative of conversations older than 15 days. This
 * touches Agent Code's rendered history, never the Claude SDK session files. */
export function compactOldConversations(list: Conversation[], now = Date.now()): Conversation[] {
  return list.map((conversation) => {
    if (now - conversation.createdAt < COMPACTION_AGE_MS) return conversation
    const messages = conversation.messages.filter(
      (message: UIMessage) => message.kind === 'user' || (message.kind === 'assistant-text' && message.answer)
    )
    return messages.length === conversation.messages.length ? conversation : { ...conversation, messages }
  })
}

/** Read a key from SQLite, falling back to (and migrating from) old localStorage. */
async function readMigrating(key: string): Promise<string | null> {
  let raw: string | null = null
  try {
    raw = await window.api.kvGet(key)
  } catch {
    raw = null
  }
  if (raw != null) return raw
  // Not in SQLite yet — migrate from the legacy localStorage value, once.
  let legacy: string | null = null
  try {
    legacy = localStorage.getItem(key)
  } catch {
    legacy = null
  }
  if (legacy != null) {
    try {
      await window.api.kvSet(key, legacy)
    } catch {
      /* best-effort */
    }
  }
  return legacy
}

export async function loadConversations(): Promise<Conversation[]> {
  try {
    const raw = await readMigrating(CONV_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? compactOldConversations(parsed as Conversation[]) : []
  } catch {
    return []
  }
}

export async function saveConversations(list: Conversation[]): Promise<void> {
  try {
    // Drop attached-image data URLs when persisting — they're large and only
    // shown during the session.
    const json = JSON.stringify(compactOldConversations(list), (key, value) => (key === 'images' ? undefined : value))
    await window.api.kvSet(CONV_KEY, json)
  } catch {
    /* store error — history is best-effort */
  }
}

export async function loadUi(): Promise<UiState> {
  const fallback: UiState = {
    collapsed: false,
    activeId: null,
    browserMinimized: false,
    browserWidth: DEFAULT_BROWSER_WIDTH
  }
  try {
    const raw = await readMigrating(UI_KEY)
    if (raw) return { ...fallback, ...JSON.parse(raw) }
  } catch {
    /* ignore */
  }
  return fallback
}

export async function saveUi(ui: UiState): Promise<void> {
  try {
    await window.api.kvSet(UI_KEY, JSON.stringify(ui))
  } catch {
    /* ignore */
  }
}

/** Load the last known account-wide rate-limit snapshot (5h / weekly / etc.).
 *  Falls back to legacy localStorage once, like the other UI/conversation keys. */
export async function loadUsageLimits(): Promise<Record<string, RateLimitStatus>> {
  try {
    const raw = await readMigrating(USAGE_LIMITS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, RateLimitStatus>) : {}
  } catch {
    return {}
  }
}

/** Persist the account-wide rate-limit snapshot so the badge is visible on
 *  app launch even before the next agent turn. */
export async function saveUsageLimits(limits: Record<string, RateLimitStatus>): Promise<void> {
  try {
    await window.api.kvSet(USAGE_LIMITS_KEY, JSON.stringify(limits))
  } catch {
    /* store error — usage badge is best-effort */
  }
}
