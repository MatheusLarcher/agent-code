import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type {
  AgentEventMsg,
  BrowserState,
  ChatEvent,
  FileAttachment,
  FileRefAttachment,
  ImageAttachment,
  PermissionRequest,
  PermissionResponse,
  PickedElement,
  QuestionAnswer,
  RateLimitStatus,
  RepositoryChange,
  StorageStatusDto,
  TabKind
} from '@shared/ipc'
import {
  isOllamaModel,
  isOpenAIModel,
  modelSupportsFastMode,
  OLLAMA_MODELS,
  OPENAI_MODELS,
  MODEL_EFFORT,
  DEFAULT_EFFORT,
  usageProviderOf
} from '@shared/ipc'
import type { EffortLevel, ProjectTree } from '@shared/ipc'
import { fileTouches, turnsOf } from './projectActivity'
import type { Conversation, TodoItem, TodoPlan, UIMessage } from './types'
import { DEFAULT_TITLE } from './types'
import { MAX_GENERIC_RETRIES, scheduleFailure, shouldRecoverTerminal } from './turnRecovery'
import { closeRunningTracks, isSubagentEvent, reduceTracks, type TrackMap } from './agentTracks'
import {
  loadConversations,
  loadUi,
  saveConversations,
  saveUi,
  loadUsageLimits,
  saveUsageLimits,
  loadConversationChanges,
  markConversationsDirty
} from './storage'
import { ChatPanel } from './components/ChatPanel'
import { BrowserPanel } from './components/BrowserPanel'
import { AgentsPanel } from './components/AgentsPanel'
import { IconGlobe, IconUsers } from './components/Icons'
import { Sidebar, type SidebarProject } from './components/Sidebar'
import { UsageBadge, type UsageProviders } from './components/UsageBadge'
import { RightPaneTabs } from './components/RightPaneTabs'
import { IconPower, IconSettings, IconSmartphone } from './components/Icons'
import { useUI } from './ui/UiProvider'
import { PermissionModal } from './ui/PermissionModal'
import { QuestionModal } from './ui/QuestionModal'
import { splitForSpeech, toSpeechText } from '@shared/speechText'
import { NewTabModal } from './ui/NewTabModal'
import { FilePickerModal } from './ui/FilePickerModal'
import { RemoteModal } from './ui/RemoteModal'
import { SettingsModal } from './ui/SettingsModal'
import { ipcErrorMessage } from './ipcError'

export type { UserMessage, UIMessage } from './types'

const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' }
]

/** Labels for models no longer offered in the selector (Opus 4.8 was retired from
 *  the list when Opus 5 shipped). Old conversations keep running on whatever model
 *  they were created with, so the picker still has to be able to SHOW that model —
 *  otherwise the <select> falls back to its first option and the UI would claim a
 *  model the session isn't actually using. See modelsFor. */
const LEGACY_MODEL_LABELS: Record<string, string> = {
  'claude-opus-4-8': 'Opus 4.8 (antigo)',
  'claude-opus-4-7': 'Opus 4.7 (antigo)',
  'claude-opus-4-6': 'Opus 4.6 (antigo)',
  'claude-opus-4-5': 'Opus 4.5 (antigo)',
  'claude-fable-5': 'Fable 5 (antigo)'
}

/** The selector list, plus `current` appended when it's a model that's no longer
 *  offered — so an old conversation shows its real model instead of silently
 *  displaying the first option. */
function modelsFor(
  list: { id: string; label: string }[],
  current: string | undefined
): { id: string; label: string }[] {
  if (!current || list.some((m) => m.id === current)) return list
  return [...list, { id: current, label: LEGACY_MODEL_LABELS[current] ?? current }]
}

const EFFORT_LABELS: Record<string, string> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo'
}

/** Effort levels available for a given model id (empty = no effort support, hide the selector). */
function effortLevelsFor(modelId: string | undefined): { value: string; label: string }[] {
  if (!modelId) return []
  const levels = MODEL_EFFORT[modelId]
  if (!levels || levels.length === 0) return []
  return levels.map((v) => ({ value: v, label: EFFORT_LABELS[v] || v }))
}

const EMPTY_TOKENS = { context: 0, output: 0, cost: 0, lastOutput: 0, lastCost: 0 }

/** Whether an incoming account-usage snapshot should be IGNORED as a spurious
 *  zero. A fresh session sometimes reports 0% / "já resetou" before the backend
 *  has real numbers, wiping a perfectly valid badge. Rule: drop the update only
 *  when it claims ~0 usage while the SAVED snapshot still says the window hasn't
 *  reset yet (resetsAt in the future) — a genuine reset (time already passed)
 *  keeps flowing through and zeroes the badge normally. */
export function isSpuriousUsageZero(prev: RateLimitStatus | undefined, next: RateLimitStatus): boolean {
  if (!prev) return false
  const nextPct = next.utilization ?? 0
  if (nextPct > 0) return false
  const prevPct = prev.utilization ?? 0
  if (prevPct <= 0) return false
  return typeof prev.resetsAt === 'number' && prev.resetsAt > Date.now()
}

/** A message waiting in the per-conversation outbox while the agent is busy. */
interface QueuedMessage {
  id: string
  convId: string
  /** Full payload sent to the agent (text + appended page-element refs). */
  full: string
  /** Original text (for display and the conversation title). */
  text: string
  images: ImageAttachment[]
  /** Data-URL thumbnails for display. */
  thumbs: string[]
  /** Non-image file attachments (saved to disk by main on send). */
  files: FileAttachment[]
  /** Attachments resolved from a pasted local path or URL (path only, no bytes). */
  fileRefs: FileRefAttachment[]
}

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] || p
}

function deriveTitle(text: string): string {
  const first = text.trim().split('\n')[0].trim()
  if (!first) return DEFAULT_TITLE
  return first.length > 48 ? first.slice(0, 48) + '…' : first
}

function uid(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

// Immutable Set helpers (React needs a new reference to re-render).
function withId(s: Set<string>, id: string): Set<string> {
  return new Set(s).add(id)
}
function withoutId(s: Set<string>, id: string): Set<string> {
  const n = new Set(s)
  n.delete(id)
  return n
}
function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const n = { ...rec }
  delete n[key]
  return n
}

/** Pure reducer for a conversation's message list (system events handled by the caller). */
/** True for the tool-use event that carries a TodoWrite call — these are
 *  diverted to `Conversation.todoPlan` (see `extractTodoPlan`) instead of
 *  becoming a generic ToolCard in the message feed. */
function isTodoWriteToolUse(e: ChatEvent): e is Extract<ChatEvent, { kind: 'tool-use' }> {
  return e.kind === 'tool-use' && e.name === 'TodoWrite'
}

/** TaskCreate/TaskUpdate are the tool pair actually used in practice today
 *  (TodoWrite is kept working above but real sessions don't call it) — same
 *  treatment: diverted to `Conversation.todoPlan` instead of the message feed. */
function isTaskCreateToolUse(e: ChatEvent): e is Extract<ChatEvent, { kind: 'tool-use' }> {
  return e.kind === 'tool-use' && e.name === 'TaskCreate'
}
function isTaskUpdateToolUse(e: ChatEvent): e is Extract<ChatEvent, { kind: 'tool-use' }> {
  return e.kind === 'tool-use' && e.name === 'TaskUpdate'
}

/** Shared by both TodoWrite and TaskUpdate validation, so the set of valid
 *  statuses can't silently drift between the two paths. */
const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const
function isTodoStatus(s: unknown): s is TodoItem['status'] {
  return typeof s === 'string' && (TODO_STATUSES as readonly string[]).includes(s)
}

/** Validate + extract a TodoWrite call's todo list. `input` is `unknown` (it
 *  comes from the SDK as-is) — checked defensively rather than trusting the
 *  shape, since a malformed/future SDK payload shouldn't crash the reducer. */
function extractTodoPlan(e: Extract<ChatEvent, { kind: 'tool-use' }>): TodoPlan | null {
  const input = e.input as { todos?: unknown } | null
  const todos = input?.todos
  if (!Array.isArray(todos)) return null
  const items: TodoItem[] = []
  for (const t of todos) {
    if (
      typeof t !== 'object' ||
      t === null ||
      typeof (t as TodoItem).content !== 'string' ||
      typeof (t as TodoItem).activeForm !== 'string' ||
      !isTodoStatus((t as TodoItem).status)
    ) {
      return null
    }
    items.push(t as TodoItem)
  }
  return { items, active: true }
}

/** TaskCreate has no id in its input — the SDK only assigns one once the call
 *  resolves — so a new item is keyed by the tool-use call's own id until
 *  `applyTaskResult` resolves it to the real task id. */
function applyTaskCreate(plan: TodoPlan | undefined, e: Extract<ChatEvent, { kind: 'tool-use' }>): TodoPlan | null {
  const input = e.input as { subject?: unknown; activeForm?: unknown } | null
  const subject = input?.subject
  if (typeof subject !== 'string') return null
  const activeForm = typeof input?.activeForm === 'string' && input.activeForm ? input.activeForm : subject
  const item: TodoItem = { id: e.id, content: subject, activeForm, status: 'pending' }
  return { items: [...(plan?.items ?? []), item], active: true }
}

/** Resolves a pending TaskCreate item's temp id to the real task id, parsed
 *  from the result text (e.g. "Task #3 created successfully: ..." — the SDK
 *  never puts the id in structured output, only in this message). Returns
 *  null (no plan change) for any result that isn't one of ours, so this is
 *  safe to call for every tool-result event, not just Task ones. */
function applyTaskResult(plan: TodoPlan | undefined, e: Extract<ChatEvent, { kind: 'tool-result' }>): TodoPlan | null {
  if (!plan) return null
  const i = plan.items.findIndex((it) => it.id === e.toolUseId)
  if (i < 0) return null
  if (e.isError) return { ...plan, items: plan.items.filter((_, idx) => idx !== i) }
  const match = /Task #(\d+)/.exec(e.text)
  if (!match) return null // can't resolve the real id — item stays under its temp id
  const items = [...plan.items]
  items[i] = { ...items[i], id: match[1] }
  return { ...plan, items }
}

/** Applies a TaskUpdate call (status/subject/activeForm patch, or removal on
 *  `status: 'deleted'`) to the item with a matching resolved id. An unknown
 *  taskId (never resolved, or just invalid) is a no-op, same defensive
 *  philosophy as extractTodoPlan — a stray/malformed call can't crash this. */
function applyTaskUpdate(plan: TodoPlan | undefined, e: Extract<ChatEvent, { kind: 'tool-use' }>): TodoPlan | null {
  if (!plan) return null
  const input = e.input as
    | { taskId?: unknown; status?: unknown; subject?: unknown; activeForm?: unknown }
    | null
  const taskId = input?.taskId
  if (typeof taskId !== 'string') return null
  const i = plan.items.findIndex((it) => it.id === taskId)
  if (i < 0) return null
  if (input?.status === 'deleted') return { ...plan, items: plan.items.filter((_, idx) => idx !== i) }
  const items = [...plan.items]
  const patched = { ...items[i] }
  if (isTodoStatus(input?.status)) patched.status = input.status
  if (typeof input?.subject === 'string') patched.content = input.subject
  if (typeof input?.activeForm === 'string') patched.activeForm = input.activeForm
  items[i] = patched
  return { ...plan, items }
}

function reduceMessages(prev: UIMessage[], e: ChatEvent): UIMessage[] {
  // Subagent work never joins the chat feed — it would interleave with the main
  // agent's answer. It goes to the agents panel instead (see agentTracks.ts).
  if (isSubagentEvent(e)) return prev
  // TodoWrite/TaskCreate/TaskUpdate calls never join the message feed — they
  // update Conversation.todoPlan instead (handled in onEvent, alongside this call).
  if (isTodoWriteToolUse(e) || isTaskCreateToolUse(e) || isTaskUpdateToolUse(e)) return prev
  if (e.kind === 'background-tasks' || e.kind === 'task-list') return prev
  if (e.kind === 'assistant-text') {
    const i = prev.findIndex((m) => m.kind === 'assistant-text' && m.id === e.id)
    if (i >= 0) {
      const copy = [...prev]
      copy[i] = { ...e }
      return copy
    }
  }
  if (e.kind === 'tool-result') {
    const i = prev.findIndex((m) => m.kind === 'tool-use' && m.id === e.toolUseId)
    if (i >= 0) {
      const copy = [...prev]
      copy[i] = { ...copy[i], result: { isError: e.isError, text: e.text } }
      return copy
    }
    // Orphaned result — its tool-use was diverted above (TodoWrite/Task*), so
    // there's nothing in `prev` to attach it to. Drop it rather than letting
    // it fall through and land as a standalone message with no context.
    return prev
  }
  if (e.kind === 'result') {
    // The result text duplicates the final answer and the cost is in the header,
    // so we don't render it — we only mark the last assistant text as the answer.
    const copy = [...prev]
    for (let i = copy.length - 1; i >= 0; i--) {
      if (copy[i].kind === 'assistant-text') {
        // Stamp the finish time so the chat can show when this answer ran (and,
        // if today, how long ago).
        copy[i] = { ...copy[i], answer: true, ts: Date.now() }
        break
      }
    }
    return copy
  }
  if (e.kind === 'system') {
    // Remove any existing system events with the same model and cwd
    // since we only want to show the latest status for a given model/cwd combination
    const filtered = prev.filter(m =>
      !(m.kind === 'system' && m.model === e.model && m.cwd === e.cwd)
    );
    return [...filtered, e as UIMessage];
  }
  return [...prev, e as UIMessage]
}

export function App(): JSX.Element {
  const { notify } = useUI()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [browserMinimized, setBrowserMinimized] = useState(false)
  const [browserWidth, setBrowserWidth] = useState(720)
  // Right-hand panel: the browser, the agents panel, or neither (rail only).
  // They share the same slot — two panels at once would squeeze the chat.
  const [agentsOpen, setAgentsOpen] = useState(false)
  // Flow view (full-screen map of who spawned whom). Opened from the panel.
  const [hydrated, setHydrated] = useState(false)
  const [storageStatus, setStorageStatus] = useState<StorageStatusDto | null>(null)
  const [storageLoadError, setStorageLoadError] = useState<string | null>(null)
  // Whether the ACTIVE conversation's project folder is gone. When true the
  // composer is blocked (can't type) — we check on switch and on window focus.
  const [projectMissing, setProjectMissing] = useState(false)
  const workspaceRef = useRef<HTMLDivElement>(null)

  // Each conversation can have its own live agent session running in parallel.
  // `connectedIds` = conversations with a live session; `busyIds` = those mid-turn;
  // `permissions` = pending tool-permission request per conversation.
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set())
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  // When the current turn started (ms epoch) and how long the last one took,
  // per conversation — drives the running-time indicator above the chat.
  const [busySince, setBusySince] = useState<Record<string, number>>({})
  const [lastDuration, setLastDuration] = useState<Record<string, number>>({})
  const [skipPerms, setSkipPerms] = useState(false)
  const [windowsControlEnabled, setWindowsControlEnabled] = useState(false)
  const [permissions, setPermissions] = useState<Record<string, PermissionRequest>>({})
  // Clicking outside an AskUserQuestion modal (or Esc) MINIMIZES it instead of
  // canceling — the question stays pending in `permissions`, just hidden; a chip
  // between the message history and the composer (ChatPanel) reopens it. Only the
  // modal's own "Cancelar" button actually discards the question.
  const [minimizedQuestions, setMinimizedQuestions] = useState<Record<string, boolean>>({})
  // Account-wide rate-limit usage (5h session / weekly / etc.) — deliberately
  // GLOBAL, not per-conversation: it comes from the Anthropic account, not from
  // any one chat, so it must survive switching conversations. Keyed by
  // rateLimitType; only ever grows/updates, never reset by the UI itself.
  const [usageLimits, setUsageLimits] = useState<Record<string, RateLimitStatus>>({})
  // Which subscriptions (Claude / GPT) the compact topbar badge shows. Persisted
  // with the rest of the UI state; the badge's own popover always shows both.
  const [usageProviders, setUsageProviders] = useState<UsageProviders>({ claude: true, gpt: true })
  // Who is working inside each conversation (main agent + subagents), for the
  // agents panel. Deliberately OUTSIDE `Conversation`: this is live state, not
  // history — it never touches the chat feed nor gets persisted to disk.
  const [tracks, setTracks] = useState<Record<string, TrackMap>>({})
  const [chips, setChips] = useState<PickedElement[]>([])
  // Whether the "new preview tab" modal is open (rendered at the app root so it
  // isn't clipped by the horizontally-scrolling tab strip).
  const [newTabOpen, setNewTabOpen] = useState(false)
  // Project file picker (for manual file-preview tabs). When set, the modal is
  // open; `replaceTabId` is the empty file tab to close once a file is chosen.
  const [filePicker, setFilePicker] = useState<{ replaceTabId?: string } | null>(null)
  // Remote control (phone bridge): modal open + whether the LAN bridge is up
  // (gates publishing conversation snapshots to main for phones to read).
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [remoteRunning, setRemoteRunning] = useState(false)
  // App settings modal (OpenAI / Ollama API keys, etc.).
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Confirmation before stopping a session whose agent is mid-task (so an
  // accidental click never kills a running turn). Holds the conversation id.
  const [stopConfirm, setStopConfirm] = useState<string | null>(null)
  // When opening Settings to nudge a missing key, focus that section.
  const [settingsFocus, setSettingsFocus] = useState<'openai' | null>(null)
  // Whether an OpenAI key is set — gates the mic and read-aloud buttons.
  const [voiceReady, setVoiceReady] = useState(false)
  // Whether Ollama Cloud is enabled with a key — adds its models to the selector.
  const [ollamaReady, setOllamaReady] = useState(false)
  // Whether a Codex (ChatGPT subscription) login exists — adds GPT models to the selector.
  const [codexReady, setCodexReady] = useState(false)
  // Models offered in the selector: Claude always, Ollama Cloud / GPT when configured.
  const models = useMemo(() => {
    let list = MODELS as { id: string; label: string }[]
    if (ollamaReady) list = [...list, ...OLLAMA_MODELS]
    if (codexReady) list = [...list, ...OPENAI_MODELS]
    return list
  }, [ollamaReady, codexReady])
  // Read-aloud speed (config), applied as the audio playbackRate (deterministic).
  const voiceSpeedRef = useRef(1)
  // Read-aloud (TTS): id of the message currently playing, and the <audio> in use.
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // Bumped to cancel an in-flight read-aloud sequence (stop / switch message).
  const speakTokenRef = useRef(0)
  // Messages typed while the agent is busy wait here (per conversation) instead
  // of being sent to the SDK — so a running task is never cancelled. The next
  // one is dispatched when the current turn finishes; the user can delete any.
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [browserState, setBrowserState] = useState<BrowserState>({
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    launched: false,
    tabs: []
  })
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // Refs so async handlers / the once-registered event listener see current values.
  const convsRef = useRef(conversations)
  convsRef.current = conversations
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const connectedRef = useRef(connectedIds)
  connectedRef.current = connectedIds
  const busyRef = useRef(busyIds)
  busyRef.current = busyIds
  const skipPermsRef = useRef(skipPerms)
  skipPermsRef.current = skipPerms
  const chipsRef = useRef(chips)
  chipsRef.current = chips
  const queueRef = useRef(queue)
  queueRef.current = queue
  const usageLimitsRef = useRef(usageLimits)
  usageLimitsRef.current = usageLimits

  // The message currently in flight per conversation (the user bubble awaiting a
  // response), so a failing turn can mark exactly that message as errored.
  const inflightRef = useRef<
    Record<
      string,
      {
        msgId: string
        sdkUuid: string
        full: string
        images: ImageAttachment[]
        files: FileAttachment[]
        fileRefs: FileRefAttachment[]
        /** The model already produced visible text for this turn. */
        responseReceived?: true
      }
    >
  >({})
  // Payloads of messages whose turn failed, kept (in memory) so "Tentar de novo"
  // resends the exact same text + attachments. Keyed by message id.
  const failedRef = useRef<
    Record<
      string,
      { convId: string; full: string; images: ImageAttachment[]; files: FileAttachment[]; fileRefs: FileRefAttachment[] }
    >
  >({})
  // Conversations the user just interrupted/stopped — their next `result` is an
  // intentional stop, not a failure, so we must not flag the message as errored.
  const interruptedRef = useRef<Set<string>>(new Set())

  // Session-bound config changed while busy: applied lazily at the next queue handoff
  // (see onEvent's success branch) instead of restarting the live turn.
  const pendingSessionConfigRef = useRef<Set<string>>(new Set())
  // onEvent is defined before connect()/stopSession() exist in this component's
  // source order; it reaches them through these refs (assigned once those
  // callbacks are created below) instead of closing over the not-yet-initialized
  // consts directly, which would throw (TDZ) on every render.
  const connectRef = useRef<((conv: Conversation) => Promise<void>) | null>(null)
  const stopSessionRef = useRef<((id: string, opts?: { silent?: boolean }) => Promise<void>) | null>(null)

  const getActive = (): Conversation | null =>
    convsRef.current.find((c) => c.id === activeIdRef.current) ?? null

  const patchConv = useCallback((id: string, fn: (c: Conversation) => Conversation): void => {
    setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)))
  }, [])

  // Set/clear busy for a conversation, keeping the ref in sync for the async
  // send path (which reads busyRef right after awaiting connect()).
  const setBusy = useCallback((id: string, on: boolean): void => {
    busyRef.current = on ? withId(busyRef.current, id) : withoutId(busyRef.current, id)
    setBusyIds((s) => (on ? withId(s, id) : withoutId(s, id)))
  }, [])
  const setConnected = useCallback((id: string, on: boolean): void => {
    connectedRef.current = on ? withId(connectedRef.current, id) : withoutId(connectedRef.current, id)
    setConnectedIds((s) => (on ? withId(s, id) : withoutId(s, id)))
  }, [])

  // Flag/clear the error banner on a specific user message (so a failed turn is
  // visible right on the message, with a retry button — instead of being lost).
  const markMessageError = useCallback(
    (convId: string, msgId: string, text: string): void => {
      patchConv(convId, (c) => ({
        ...c,
        messages: c.messages.map((m) => (m.kind === 'user' && m.id === msgId ? { ...m, error: text } : m))
      }))
    },
    [patchConv]
  )
  const clearMessageError = useCallback(
    (convId: string, msgId: string): void => {
      patchConv(convId, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.kind === 'user' && m.id === msgId ? { ...m, error: undefined } : m
        )
      }))
    },
    [patchConv]
  )

  // ---- agent event stream (each event is tagged with its conversation) ----
  const onEvent = useCallback(
    ({ convId: cid, event: e }: AgentEventMsg) => {
      // Account-wide, not conversation-wide — skip patchConv entirely (no
      // message bubble, no per-conv token/turn bookkeeping applies here).
      if (e.kind === 'rate-limit') {
        setUsageLimits((prev) =>
          isSpuriousUsageZero(prev[e.limits.rateLimitType], e.limits)
            ? prev
            : { ...prev, [e.limits.rateLimitType]: e.limits }
        )
        return
      }
      // Agents panel: `Task` calls open a track, subagent calls feed it, and the
      // Task's own result closes it. Kept apart from the message reducer below —
      // the chat feed must not change because of this.
      setTracks((prev) => {
        const map = prev[cid] ?? {}
        const next = reduceTracks(map, e)
        return next === map ? prev : { ...prev, [cid]: next }
      })

      patchConv(cid, (c) => {
        let next: Conversation
        if (e.kind === 'system') {
          next = {
            ...c,
            sdkSessionId: e.sessionId,
            model: e.model || c.model,
            // Only keep one "session ready" note even across resumes.
            messages: c.messages.some((m) => m.kind === 'system')
              ? c.messages
              : [...c.messages, e as UIMessage]
          }
        } else {
          next = { ...c, messages: reduceMessages(c.messages, e), updatedAt: Date.now() }
        }
        // TodoWrite replaces the whole plan (never appends) — one live
        // checklist per conversation, not a new card per call. TaskCreate/
        // TaskUpdate (the pair actually used in practice) instead patch it
        // incrementally, by id. Any malformed/unresolved input is dropped
        // silently (apply*/extract* → null) rather than clobbering whatever
        // plan was already showing.
        if (isTodoWriteToolUse(e)) {
          const plan = extractTodoPlan(e)
          if (plan) next = { ...next, todoPlan: plan }
        } else if (isTaskCreateToolUse(e)) {
          const plan = applyTaskCreate(next.todoPlan, e)
          if (plan) next = { ...next, todoPlan: plan }
        } else if (isTaskUpdateToolUse(e)) {
          const plan = applyTaskUpdate(next.todoPlan, e)
          if (plan) next = { ...next, todoPlan: plan }
        } else if (e.kind === 'tool-result') {
          const plan = applyTaskResult(next.todoPlan, e)
          if (plan) next = { ...next, todoPlan: plan }
        } else if (e.kind === 'task-list') {
          // Authoritative snapshot straight from the CLI's task files — replaces
          // the incrementally-built list, which goes stale for every event this
          // app didn't see (closed app, machine restart, chat resumed later).
          // An empty snapshot is only trusted when there IS a plan built from
          // tasks; a TodoWrite-only plan (no ids) is left alone.
          const fromTasks = next.todoPlan?.items.some((it) => it.id) ?? false
          if (e.items.length || fromTasks) {
            // Spinner follows the real turn state, not the last event we saw: a
            // snapshot arriving mid-turn (resume, watcher tick) means the agent
            // IS working on this plan right now.
            next = { ...next, todoPlan: { items: e.items, active: busyRef.current.has(cid) } }
          }
        } else if (e.kind === 'background-tasks') {
          next = { ...next, backgroundTasks: e.tasks }
        }
        if ((e.kind === 'result' || e.kind === 'error') && next.todoPlan) {
          next = { ...next, todoPlan: { ...next.todoPlan, active: false } }
        }
        if (e.kind === 'result' && e.usage) {
          const u = e.usage
          next = {
            ...next,
            tokens: {
              // Real context-window size of the last model request (not the
              // per-turn sum); falls back to the old computation if absent.
              context: e.contextTokens ?? u.input + u.cacheRead + u.cacheWrite,
              output: c.tokens.output + u.output,
              cost: c.tokens.cost + (e.costUsd ?? 0),
              lastOutput: u.output,
              lastCost: e.costUsd ?? 0
            }
          }
        }
        return next
      })

      // Self-heal the "working" indicator: if real turn activity lands for a
      // conversation we think is idle, it wasn't actually done — a stray/early
      // `result` (e.g. a subagent's own, now filtered in agentSession.ts, but
      // this is a safety net against any other way that could happen) must not
      // leave the spinner/timer/banner stuck off while the agent keeps working.
      // Scoped to ONLY busyIds/busySince — never re-runs the end-of-turn cleanup
      // (queue dispatch, permission clearing, error marking) below.
      const isActivity =
        e.kind === 'assistant-text' || e.kind === 'thinking' || e.kind === 'tool-use' || e.kind === 'tool-result' || e.kind === 'status'
      if (e.kind === 'assistant-text' && e.text.trim()) {
        const inflight = inflightRef.current[cid]
        if (inflight) inflight.responseReceived = true
      }
      // O agente voltou a responder de fato: o cartão de recuperação ("Limite do
      // Claude atingido" / "Tentativas automáticas encerradas") não pode continuar
      // na tela enquanto a resposta chega — some na primeira atividade real.
      if (isActivity) patchConv(cid, (c) => (c.recovery ? { ...c, recovery: undefined } : c))
      if (isActivity && !busyRef.current.has(cid)) {
        setBusy(cid, true)
        setBusySince((m) => (m[cid] ? m : { ...m, [cid]: Date.now() }))
      }

      if (e.kind === 'result' || e.kind === 'error') {
        // A finished turn has no outstanding permission request — clear any so a
        // stale modal can't reappear when this conversation becomes active again.
        setPermissions((p) => withoutKey(p, cid))
        setMinimizedQuestions((m) => withoutKey(m, cid))
        // Nothing can still be running once the turn is over: a subagent whose
        // closing result we missed would otherwise spin in the panel forever.
        setTracks((prev) => {
          const map = prev[cid]
          if (!map) return prev
          const next = closeRunningTracks(map)
          return next === map ? prev : { ...prev, [cid]: next }
        })

        // Did the user just stop this turn? A user interrupt/stop ends with a
        // `result` (sometimes flagged is_error); that's intentional, not a failure.
        const wasInterrupted = interruptedRef.current.delete(cid)
        if (!wasInterrupted) {
          patchConv(cid, (c) => ({ ...c, queuedAfterInterrupt: undefined }))
        }
        // A failed turn = a fatal session error, or a result the model flagged as
        // an error and that the user did NOT cause by stopping it. The user's
        // message must stay in the chat, marked with the error + a retry button.
        // Some providers can deliver the assistant text and only then mark the
        // terminal frame as an error. The user already received an answer, so
        // that is a completed turn — never resurrect the retry card afterward.
        const receivedResponse = inflightRef.current[cid]?.responseReceived === true
        const failed = !receivedResponse && shouldRecoverTerminal(e.kind, e.kind === 'result' && e.isError, wasInterrupted)

        if (e.kind === 'result' && !e.isError) setLastDuration((m) => ({ ...m, [cid]: e.durationMs }))

        if (failed) {
          // Suspend this turn instead of treating it as complete. The queue stays
          // frozen until the automatic continuation actually succeeds.
          const inflight = inflightRef.current[cid]
          if (inflight) {
            failedRef.current[inflight.msgId] = {
              convId: cid,
              full: inflight.full,
              images: inflight.images,
              files: inflight.files,
              fileRefs: inflight.fileRefs
            }
            markMessageError(cid, inflight.msgId, e.text || 'A resposta falhou. Tente de novo.')
          }
          delete inflightRef.current[cid]
          // Only this conversation's subscription windows can say when its
          // limit resets — a GPT window must not schedule a Claude retry.
          const failedModel = convsRef.current.find((c) => c.id === cid)?.model
          const failedProvider = isOpenAIModel(failedModel) ? 'gpt' : 'claude'
          const relevantLimits = Object.fromEntries(
            Object.entries(usageLimitsRef.current).filter(
              ([, l]) => usageProviderOf(l.rateLimitType) === failedProvider
            )
          )
          const schedule = scheduleFailure(e.text || 'Erro transitório', relevantLimits)
          const previousRecovery = convsRef.current.find((c) => c.id === cid)?.recovery
          const attempt = schedule.reason === 'transient' ? (previousRecovery?.attempt ?? 0) + 1 : 0
          const exhausted = schedule.reason === 'transient' && attempt >= MAX_GENERIC_RETRIES
          patchConv(cid, (c) => {
            return {
              ...c,
              recovery: {
                id: uid('recovery'),
                reason: schedule.reason,
                scheduledAt: exhausted ? 0 : schedule.scheduledAt,
                attempt,
                maxAttempts: MAX_GENERIC_RETRIES,
                errorText: e.text || 'Erro transitório',
                messageId: inflight?.msgId ?? c.recovery?.messageId ?? null
              }
            }
          })
          setBusy(cid, !exhausted)
          setBusySince((m) => withoutKey(m, cid))

          if (e.kind === 'error') {
            // Fatal session error: surface it (a background chat has no visible
            // bubble) and allow reconnecting this conversation.
            notify('erro', e.text)
            setConnected(cid, false)
          }
          return
        }

        // Turn succeeded → the in-flight message got its answer; dispatch the next
        // queued message for this conversation (if any). The conversation stays
        // "busy" through the handoff; only when the queue is empty do we go idle.
        delete inflightRef.current[cid]
        patchConv(cid, (c) => ({ ...c, recovery: undefined }))
        // A session-bound setting (model, effort, Loop or Econômico) changed
        // while busy — apply it now, at the handoff, by restarting the live
        // session (same resume id, so history carries over) before the next
        // message goes out.
        const sessionConfigPending = pendingSessionConfigRef.current.has(cid)
        if (sessionConfigPending) pendingSessionConfigRef.current = withoutId(pendingSessionConfigRef.current, cid)
        const next = queueRef.current.find((m) => m.convId === cid)
        if (next) {
          setQueue((cur) => cur.filter((m) => m.id !== next.id))
          const nextMsgId = uid('u')
          patchConv(cid, (c) => ({
            ...c,
            title: c.title === DEFAULT_TITLE && next.text.trim() ? deriveTitle(next.text) : c.title,
            messages: [
              ...c.messages,
              {
                kind: 'user',
                id: nextMsgId,
                text: next.text,
                images: next.thumbs.length ? next.thumbs : undefined,
                files:
                  next.files.length || next.fileRefs.length
                    ? [...next.files, ...next.fileRefs].map((f) => ({ name: f.name, size: f.size }))
                    : undefined,
                ts: Date.now()
              }
            ],
            updatedAt: Date.now()
          }))
          const sdkUuid = crypto.randomUUID()
          inflightRef.current[cid] = {
            msgId: nextMsgId,
            sdkUuid,
            full: next.full,
            images: next.images,
            files: next.files,
            fileRefs: next.fileRefs
          }
          void (async () => {
            if (sessionConfigPending) {
              // Dispose the stale-config session and reconnect (same resume id, so
              // history carries over) before this queued message goes out.
              await stopSessionRef.current?.(cid, { silent: true })
              setBusy(cid, true) // stopSession() clears busy; the handoff stays busy
              const fresh = convsRef.current.find((c) => c.id === cid)
              if (fresh) await connectRef.current?.(fresh)
            }
            await window.api.sendMessage(cid, next.full, next.images, next.files, next.fileRefs, sdkUuid)
          })()
          setBusySince((m) => ({ ...m, [cid]: Date.now() })) // restart timer for the next turn
        } else if (sessionConfigPending) {
          // No more queued messages: drop the session now so the next message the
          // user types reconnects with the new config. Must be awaited before
          // clearing `busy` — otherwise the user can send before disposeAgent()
          // releases the write lease in main, and that send fails with
          // "conversa não possui lease de escrita ativo" (connectedRef still
          // true, so dispatch skips connect() and goes straight to agentSend).
          void (async () => {
            await stopSessionRef.current?.(cid, { silent: true })
            setBusy(cid, false)
            setBusySince((m) => withoutKey(m, cid))
          })()
        } else {
          setBusy(cid, false)
          setBusySince((m) => withoutKey(m, cid)) // stop the running timer
        }
      }
    },
    [patchConv, notify, setBusy, setConnected, markMessageError]
  )

  useEffect(() => {
    const offEvent = window.api.onAgentEvent(onEvent)
    const offPerm = window.api.onPermissionRequest(({ convId, req }) => {
      setPermissions((p) => ({ ...p, [convId]: req }))
      // A fresh request always starts visible, even if a previous one in this
      // conversation had been minimized.
      setMinimizedQuestions((m) => withoutKey(m, convId))
      // A background conversation's permission modal isn't visible (only the
      // active one renders) — toast so the user knows that chat is waiting,
      // otherwise its session (and queue) would silently freeze.
      if (convId !== activeIdRef.current) {
        const title = convsRef.current.find((c) => c.id === convId)?.title ?? 'Outra conversa'
        const what = req.questions ? 'uma resposta' : 'uma permissão'
        notify('aviso', `“${title}” está aguardando ${what}.`)
      }
    })
    // A pending question/permission timed out on the main side and was
    // auto-resolved — close its modal here (only if it's still the same request).
    const offExpired = window.api.onPermissionExpired(({ convId, id }) => {
      setPermissions((p) => (p[convId]?.id === id ? withoutKey(p, convId) : p))
      setMinimizedQuestions((m) => withoutKey(m, convId))
    })
    const offState = window.api.onBrowserState(setBrowserState)
    const offPicked = window.api.onBrowserPicked((el) => {
      setChips((c) => [...c, el])
      composerRef.current?.focus()
    })
    return () => {
      offEvent()
      offPerm()
      offExpired()
      offState()
      offPicked()
    }
  }, [onEvent])

  // ---- load persisted history once (async: SQLite via main, migrates localStorage) ----
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [loaded, ui, limits, initialStorageStatus] = await Promise.all([
          loadConversations(),
          loadUi(),
          loadUsageLimits(),
          window.api.getStorageStatus()
        ])
        if (!initialStorageStatus.writable) {
          throw new Error(initialStorageStatus.error?.message ?? 'Persistência autoritativa indisponível.')
        }
      if (cancelled) return
      setStorageStatus(initialStorageStatus)
      // Live SDK state never survives an app process restart. Avoid briefly
      // painting stale background/interrupt warnings from persisted history.
      setConversations(
        loaded.map((conversation) => ({
          ...conversation,
          // Corrupt/legacy state must never resurrect both mutually-exclusive
          // modes. Economy wins because it is the stricter execution mode.
          loopEnabled: conversation.economyMode === true ? false : conversation.loopEnabled === true,
          backgroundTasks: [],
          queuedAfterInterrupt: undefined,
          // A turn interrupted by the app closing never delivers its
          // result/error event, so a persisted `active: true` (and any
          // `in_progress` item) would show a spinner forever.
          todoPlan: conversation.todoPlan
            ? {
                ...conversation.todoPlan,
                active: false,
                items: conversation.todoPlan.items.map((item) =>
                  item.status === 'in_progress' ? { ...item, status: 'pending' as const } : item
                )
              }
            : undefined
        }))
      )
      setCollapsed(ui.collapsed)
      setBrowserMinimized(ui.browserMinimized)
      setBrowserWidth(ui.browserWidth)
      setUsageProviders(ui.usageProviders)
      setActiveId(
        ui.activeId && loaded.some((c) => c.id === ui.activeId) ? ui.activeId : loaded[0]?.id ?? null
      )
      // Seed the badge from storage: live events win, EXCEPT when the live
      // value is a spurious zero and the stored snapshot is still valid —
      // then the stored one prevails (same rule as the live-event guard).
      setUsageLimits((prev) => {
        const merged = { ...limits, ...prev }
        for (const [type, stored] of Object.entries(limits)) {
          if (prev[type] && isSpuriousUsageZero(stored, prev[type])) merged[type] = stored
        }
        return merged
      })
      setHydrated(true)
      } catch (error) {
        if (cancelled) return
        setStorageLoadError(ipcErrorMessage(error, 'Não foi possível carregar a persistência.'))
        void window.api.getStorageStatus().then(setStorageStatus).catch(() => undefined)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const offStatus = window.api.onStorageStatusChanged((status) => {
      setStorageStatus(status)
      if (!status.writable) {
        setStorageLoadError(status.error?.message ?? 'Persistência autoritativa indisponível.')
      }
    })
    const offChanges = window.api.onStorageChanged((changes: RepositoryChange[]) => {
      if (changes.some((change) => change.entity.endsWith('-kv') && change.entityId.startsWith('config.'))) {
        void window.api.getConfig().then((config) => {
          skipPermsRef.current = config.skipPermissions
          setSkipPerms(config.skipPermissions)
          setWindowsControlEnabled(config.windowsControlEnabled === true)
          setVoiceReady(Boolean(config.openai.apiKey.trim()))
          setOllamaReady(config.ollama.enabled && Boolean(config.ollama.apiKey.trim()))
          voiceSpeedRef.current = config.openai.speed || 1
        }).catch(() => undefined)
      }
      void loadConversationChanges(changes)
        .then((updates) => {
          if (!updates.size) return
          setConversations((current) => {
            const byId = new Map(current.map((conversation) => [conversation.id, conversation]))
            for (const [id, conversation] of updates) {
              if (conversation) byId.set(id, conversation)
              else byId.delete(id)
            }
            return [...byId.values()]
          })
        })
        .catch((error) => {
          setStorageLoadError(ipcErrorMessage(error, 'Falha ao sincronizar alterações.'))
        })
    })
    return () => {
      offStatus()
      offChanges()
    }
  }, [])

  // Persist the account-wide usage snapshot whenever it changes, so the badge
  // shows the last known value on the next app launch. Skip the initial empty
  // state — it would overwrite the stored snapshot before loadUsageLimits runs.
  useEffect(() => {
    if (Object.keys(usageLimits).length === 0) return
    void saveUsageLimits(usageLimits)
  }, [usageLimits])

  // Load persisted app config once (e.g. the "Permitir tudo" toggle).
  useEffect(() => {
    void window.api.getConfig()
      .then((c) => {
        skipPermsRef.current = c.skipPermissions
        setSkipPerms(c.skipPermissions)
        setWindowsControlEnabled(c.windowsControlEnabled === true)
        setVoiceReady(!!c.openai?.apiKey?.trim())
        setOllamaReady(!!c.ollama?.enabled && !!c.ollama?.apiKey?.trim())
        voiceSpeedRef.current = c.openai?.speed || 1
      })
      .catch(() => undefined)
    void window.api.codexStatus().then((s) => setCodexReady(s.connected))
  }, [])

  useEffect(() => window.api.onWindowsControlChanged(setWindowsControlEnabled), [])

  // Tell main which conversation's browser the panel should show, so each chat
  // gets its own independent browser instance.
  useEffect(() => {
    if (hydrated) void window.api.setActiveBrowser(activeId)
  }, [activeId, hydrated])

  // Poll the latest account-wide usage every 5 minutes on any connected
  // session, so the badge reflects reality even when the agent isn't answering.
  useEffect(() => {
    const id = setInterval(() => {
      const target =
        activeId && connectedIds.has(activeId) ? activeId : Array.from(connectedIds)[0]
      if (target) void window.api.refreshUsage(target)
    }, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [activeId, connectedIds])

  // Verify the active conversation's project folder still exists, so the composer
  // can block typing when it's gone (instead of only failing at send time). Re-check
  // on conversation switch and whenever the window regains focus (the folder may
  // have been moved/deleted while the app was in the background).
  useEffect(() => {
    const conv = convsRef.current.find((c) => c.id === activeId)
    if (!conv) {
      setProjectMissing(false)
      return
    }
    let cancelled = false
    const check = (): void => {
      void window.api.pathExists(conv.cwd).then((ok) => {
        if (!cancelled) setProjectMissing(!ok)
      })
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      cancelled = true
      window.removeEventListener('focus', check)
    }
  }, [activeId, hydrated])

  // ---- persist (debounced for the rapidly-changing message stream) ----
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const savedSnapshotRef = useRef<Map<string, Conversation>>(new Map())
  useEffect(() => {
    if (!hydrated) return
    // Mark what changed as dirty IMMEDIATELY (cheap identity compare — React
    // replaces the object of every patched conversation). Waiting for the
    // debounced write to do it leaves a window where a change-feed notification
    // would restore the last persisted revision and the new message would
    // disappear from the screen right after showing up.
    const changed: string[] = []
    const snapshot = new Map<string, Conversation>()
    for (const conversation of conversations) {
      snapshot.set(conversation.id, conversation)
      if (savedSnapshotRef.current.get(conversation.id) !== conversation) changed.push(conversation.id)
    }
    savedSnapshotRef.current = snapshot
    if (changed.length) markConversationsDirty(changed)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      void saveConversations(convsRef.current).catch((error) => {
        const reason = ipcErrorMessage(error, 'A persistência rejeitou a gravação.')
        console.error('[conversation-storage]', reason)
        notify('erro', `Não foi possível salvar o histórico. Motivo: ${reason} A conversa continua marcada como não salva.`)
      })
    }, 400)
    return () => clearTimeout(saveTimer.current)
  }, [conversations, hydrated, notify])
  useEffect(() => {
    if (hydrated) {
      void saveUi({ collapsed, activeId, browserMinimized, browserWidth, usageProviders }).catch(() =>
        notify('erro', 'Não foi possível salvar o estado da interface.')
      )
    }
  }, [collapsed, activeId, browserMinimized, browserWidth, usageProviders, hydrated, notify])

  // Close/reload is a durability boundary: pause the unload, flush the latest
  // conversation + UI state, then explicitly release the pending navigation.
  const hydratedRef = useRef(hydrated)
  hydratedRef.current = hydrated
  const closeUiRef = useRef({ collapsed, activeId, browserMinimized, browserWidth, usageProviders })
  closeUiRef.current = { collapsed, activeId, browserMinimized, browserWidth, usageProviders }
  const allowUnloadRef = useRef(false)
  const unloadFlushRef = useRef<Promise<void> | null>(null)
  useEffect(() => {
    const flushDurableState = async (): Promise<void> => {
      clearTimeout(saveTimer.current)
      if (!hydratedRef.current) return
      await Promise.all([saveConversations(convsRef.current), saveUi(closeUiRef.current)])
    }

    const requestReload = (): void => {
      if (allowUnloadRef.current) return
      if (!hydratedRef.current) {
        allowUnloadRef.current = true
        void window.api.appReloadReady()
        return
      }
      if (unloadFlushRef.current) return
      unloadFlushRef.current = flushDurableState()
        .then(async () => {
          allowUnloadRef.current = true
          await window.api.appReloadReady()
        })
        .catch(() => {
          notify('erro', 'Não foi possível salvar antes de recarregar. A janela permaneceu aberta.')
        })
        .finally(() => {
          unloadFlushRef.current = null
        })
    }

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (allowUnloadRef.current || !hydratedRef.current) return
      event.preventDefault()
      event.returnValue = ''
      requestReload()
    }

    const offClose = window.api.onAppCloseRequested(() => {
      if (unloadFlushRef.current) return
      unloadFlushRef.current = flushDurableState()
        .then(async () => {
          allowUnloadRef.current = true
          await window.api.appCloseReady()
        })
        .catch(() => {
          notify('erro', 'Não foi possível salvar antes de fechar. A janela permaneceu aberta.')
        })
        .finally(() => {
          unloadFlushRef.current = null
        })
    })
    const offReload = window.api.onAppReloadRequested(requestReload)
    window.addEventListener('agent-code-request-reload', requestReload)
    const offStorageFlush = window.api.onStorageFlushRequested((requestId) => {
      const pending = unloadFlushRef.current ?? flushDurableState()
      unloadFlushRef.current = pending
      void pending
        .then(() => window.api.storageFlushReady(requestId))
        .catch((error) => window.api.storageFlushReady(requestId, String(error)))
        .finally(() => {
          if (unloadFlushRef.current === pending) unloadFlushRef.current = null
        })
    })
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      offClose()
      offReload()
      window.removeEventListener('agent-code-request-reload', requestReload)
      offStorageFlush()
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [notify])

  // ---- remote bridge: track running state + publish snapshots for phones ----
  useEffect(() => {
    void window.api.remoteStatus().then((i) => setRemoteRunning(i.running))
    // onRemoteClients also fires on start/stop, so it doubles as a running signal.
    const off = window.api.onRemoteClients((i) => setRemoteRunning(i.running))
    return off
  }, [])

  const pubTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!hydrated || !remoteRunning) return
    clearTimeout(pubTimer.current)
    pubTimer.current = setTimeout(() => {
      void window.api.publishRemoteState({
        conversations: convsRef.current.map((c) => ({
          id: c.id,
          title: c.title,
          cwd: c.cwd,
          busy: busyRef.current.has(c.id),
          connected: connectedRef.current.has(c.id),
          updatedAt: c.updatedAt,
          messages: c.messages,
          queued: queueRef.current.filter((m) => m.convId === c.id).map((m) => ({ text: m.text })),
          questions: [
            ...c.messages.flatMap((m, position) =>
              m.kind === 'user' ? [{ id: m.id, text: m.text, ts: m.ts, position }] : []
            ),
            ...queueRef.current
              .filter((m) => m.convId === c.id)
              .map((m, index) => ({ id: m.id, text: m.text, position: c.messages.length + index, queued: true }))
          ],
          recovery: c.recovery
            ? {
                reason: c.recovery.reason,
                scheduledAt: c.recovery.scheduledAt,
                attempt: c.recovery.attempt,
                maxAttempts: c.recovery.maxAttempts,
                errorText: c.recovery.errorText
              }
            : undefined,
          model: c.model,
          effort: c.effort ?? DEFAULT_EFFORT,
          economyMode: c.economyMode === true,
          loopEnabled: c.loopEnabled === true,
          permission: permissions[c.id]
        })),
        skipPerms: skipPermsRef.current,
        // Catalog for the phone's selectors — same options the PC picker offers.
        models,
        modelEffort: MODEL_EFFORT,
        effortLabels: EFFORT_LABELS
      })
    }, 400)
    return () => clearTimeout(pubTimer.current)
  }, [conversations, queue, busyIds, connectedIds, remoteRunning, hydrated, skipPerms, models, permissions])

  // Drag the splitter between chat and browser to resize the browser panel; the
  // page viewport follows (BrowserPanel reports its new size to main).
  const startBrowserDrag = useCallback((e: ReactMouseEvent): void => {
    e.preventDefault()
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent): void => {
      const ws = workspaceRef.current
      if (!ws) return
      const rect = ws.getBoundingClientRect()
      // Mínimo do chat: 360px. Era 440, o que travava o painel de agentes cedo
      // demais — o mapa de fluxo precisa de largura para mostrar as ações.
      const w = Math.max(340, Math.min(rect.width - 360, rect.right - ev.clientX))
      setBrowserWidth(w)
    }
    const onUp = (): void => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // ---- conversation management ----
  const createConversation = (folder: string): Conversation => {
    // New conversations in a known project inherit that project's execution
    // modes; otherwise fall back to the active conversation's settings.
    const sameFolder = convsRef.current.find((c) => c.cwd === folder)
    const active = getActive()
    const model = sameFolder?.model || active?.model || MODELS[0].id
    const inheritedEconomy = sameFolder?.economyMode ?? active?.economyMode ?? false
    const inheritedLoop = inheritedEconomy
      ? false
      : (sameFolder?.loopEnabled ?? active?.loopEnabled ?? false)
    const conv: Conversation = {
      id: uid('c'),
      title: DEFAULT_TITLE,
      cwd: folder,
      model,
      effort: active?.effort || DEFAULT_EFFORT,
      economyMode: inheritedEconomy,
      loopEnabled: inheritedLoop,
      // Fast mode is inherited like the other per-conversation settings, but only
      // when the inherited model can actually run it.
      fastMode:
        modelSupportsFastMode(model) && (sameFolder?.fastMode ?? active?.fastMode ?? false),
      sdkSessionId: null,
      messages: [],
      tokens: { ...EMPTY_TOKENS },
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    setConversations((prev) => [conv, ...prev])
    setActiveId(conv.id)
    return conv
  }

  const newChat = useCallback(async (): Promise<void> => {
    let folder = getActive()?.cwd || convsRef.current[0]?.cwd || ''
    if (!folder) {
      folder = (await window.api.pickDirectory()) || ''
      if (!folder) {
        notify('aviso', 'Nenhuma pasta selecionada.')
        return
      }
    }
    createConversation(folder)
  }, [notify])

  const newProject = useCallback(async (): Promise<void> => {
    const folder = (await window.api.pickDirectory()) || ''
    if (folder) createConversation(folder)
    else notify('aviso', 'Nenhuma pasta selecionada.')
  }, [notify])

  // Start a new conversation inside a specific project (from the per-project "+"
  // button next to the project name in the sidebar).
  const newChatIn = useCallback((folder: string): void => {
    createConversation(folder)
  }, [])

  const selectConversation = useCallback((id: string): void => {
    setActiveId(id)
  }, [])

  // A search hit asks to open a conversation AND land on the matched message.
  // `seq` bumps each time so clicking the same result re-triggers the scroll.
  const [scrollTarget, setScrollTarget] = useState<{ convId: string; msgId: string; seq: number } | null>(null)
  const selectConversationAt = useCallback((id: string, msgId: string | null): void => {
    setActiveId(id)
    if (msgId) setScrollTarget((prev) => ({ convId: id, msgId, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  const renameConversation = useCallback(
    (id: string, title: string): void => patchConv(id, (c) => ({ ...c, title: title.trim() || c.title })),
    [patchConv]
  )

  const deleteConversation = useCallback(
    (id: string): void => {
      const next = convsRef.current.filter((c) => c.id !== id)
      void window.api.disposeAgent(id)
      void window.api.disposeBrowser(id)
      setConnected(id, false)
      setBusy(id, false)
      setBusySince((m) => withoutKey(m, id))
      setLastDuration((m) => withoutKey(m, id))
      setPermissions((p) => withoutKey(p, id))
      setMinimizedQuestions((m) => withoutKey(m, id))
      setQueue((q) => q.filter((m) => m.convId !== id))
      setConversations(next)
      if (activeIdRef.current === id) setActiveId(next[0]?.id ?? null)
    },
    [setConnected, setBusy]
  )

  // ---- agent connection ----
  // In-flight connect promises per conversation: two concurrent sends (or a send
  // racing the "Conectar" button) share ONE startAgent instead of disposing and
  // recreating the session (which would drop a message).
  const connectingRef = useRef<Map<string, Promise<void>>>(new Map())

  // Guard: the project folder must still exist before we start/talk to the agent
  // (its cwd). If it was moved/deleted, fail with a clear toast instead of sending.
  const ensureProject = useCallback(
    async (conv: Conversation): Promise<boolean> => {
      const ok = await window.api.pathExists(conv.cwd)
      if (!ok) notify('erro', `A pasta do projeto não existe mais: ${conv.cwd}`)
      return ok
    },
    [notify]
  )

  const connect = useCallback(
    (conv: Conversation): Promise<void> => {
      if (connectedRef.current.has(conv.id)) return Promise.resolve()
      const inflight = connectingRef.current.get(conv.id)
      if (inflight) return inflight
      const p = (async () => {
        // First run: if there's no Claude login yet, do /login for the user (opens
        // the system browser) instead of letting the chat tell them to type it.
        // Ollama models authenticate with the Ollama API key, and GPT models with
        // the Codex OAuth login done in Settings (both handled in main), so they
        // skip the Anthropic login entirely.
        const { authenticated } =
          isOllamaModel(conv.model) || isOpenAIModel(conv.model)
            ? { authenticated: true }
            : await window.api.authStatus()
        if (!authenticated) {
          notify('aviso', 'Abrindo o login do Claude no navegador… é só autenticar para continuar.')
          const { ok } = await window.api.authLogin()
          if (!ok) {
            notify('erro', 'Login não concluído. Clique em Conectar de novo quando autenticar.')
            throw new Error('not-authenticated')
          }
          notify('sucesso', 'Login concluído!')
        }
        // PostgreSQL leases reference an existing conversation row. Flush a
        // newly created/edited conversation before asking main to acquire it.
        await saveConversations(convsRef.current)
        const started = await window.api.startAgent({
          convId: conv.id,
          cwd: conv.cwd,
          model: conv.model,
          skipPermissions: skipPermsRef.current,
          resume: conv.sdkSessionId ?? undefined,
          effort: conv.effort,
          economyMode: conv.economyMode === true,
          loopEnabled: conv.loopEnabled === true,
          fastMode: conv.fastMode === true
        })
        if (!started.ok) throw new Error('a sessão do agente não iniciou')
        setConnected(conv.id, true)
        setPermissions((pp) => withoutKey(pp, conv.id))
        setMinimizedQuestions((m) => withoutKey(m, conv.id))
      })()
      connectingRef.current.set(conv.id, p)
      void p.then(
        () => connectingRef.current.delete(conv.id),
        () => connectingRef.current.delete(conv.id)
      )
      return p
    },
    [setConnected, notify]
  )

  // "Conectar" from the empty/first-run state (no project selected yet). Picks a
  // folder, opens the first conversation in it and connects the agent — so the
  // connect action is reachable before any conversation exists. If a conversation
  // is already active, just connect that one.
  const connectStart = useCallback(async (): Promise<void> => {
    const current = getActive()
    if (current) {
      if (!(await ensureProject(current))) return
      // connect() handles login + errors with its own toasts; swallow the reject
      // so a not-yet-finished login doesn't bubble as an unhandled error.
      try {
        await connect(current)
        notify('sucesso', `Conectado · ${basename(current.cwd)}`)
      } catch {
        /* connect already notified why */
      }
      return
    }
    const folder = (await window.api.pickDirectory()) || ''
    if (!folder) {
      notify('aviso', 'Nenhuma pasta selecionada.')
      return
    }
    const conv = createConversation(folder)
    try {
      await connect(conv)
      notify('sucesso', `Conectado · ${basename(conv.cwd)}`)
    } catch {
      /* connect already notified why */
    }
  }, [connect, notify, ensureProject])

  // End a conversation's live session (frees the model selector, which is locked
  // while connected). Interrupt first so a running turn is actually stopped, then
  // dispose. The conversation + its sdkSessionId are kept, so "Conectar" later
  // resumes the history — now on whatever model the user picked.
  const stopSession = useCallback(
    async (id: string, opts?: { silent?: boolean }): Promise<void> => {
      interruptedRef.current.add(id) // intentional stop — don't flag the message as failed
      try {
        await window.api.interrupt(id)
      } catch {
        /* not mid-turn */
      }
      await window.api.disposeAgent(id)
      setConnected(id, false)
      setBusy(id, false)
      setBusySince((m) => withoutKey(m, id))
      setPermissions((p) => withoutKey(p, id))
      setMinimizedQuestions((m) => withoutKey(m, id))
      if (!opts?.silent) notify('sucesso', 'Sessão encerrada — agora você pode trocar o modelo.')
    },
    [setConnected, setBusy, notify]
  )

  // "Parar sessão" click: if the agent is mid-task, ask first (don't kill a
  // running turn by accident); otherwise stop right away.
  const requestStopSession = useCallback((): void => {
    const id = activeIdRef.current
    if (!id) return
    if (busyRef.current.has(id)) setStopConfirm(id)
    else void stopSession(id)
  }, [stopSession])

  // Model picker: the SDK fixes the model for the life of a session, so a live
  // session must restart to pick up a change.
  // - Idle + connected: restart right away (silently dispose; no "encerrada"
  //   toast/interruption UX) so the NEXT message reconnects with the new model,
  //   same as clicking "Parar sessão" — just without the manual step.
  // - Busy (mid-turn or working through the queue): can't restart without
  //   killing the running turn, so just record the change. onEvent's
  //   turn-succeeded handler applies it at the next queue handoff — the
  //   in-flight message finishes on the old model, the next queued one (or the
  //   next one you type) opens on the new one.
  const changeModel = useCallback(
    (id: string, model: string): void => {
      // When switching models, reset effort to the default if the new model
      // doesn't support the current level (e.g. Haiku doesn't have xhigh/max).
      patchConv(id, (c) => {
        const supported = MODEL_EFFORT[model] ?? []
        const effort = c.effort && supported.includes(c.effort as EffortLevel) ? c.effort : DEFAULT_EFFORT
        // Fast mode only exists on some Opus models — drop it when moving to a
        // model that would have the API reject the request.
        const fastMode = c.fastMode === true && modelSupportsFastMode(model)
        return { ...c, model, effort, fastMode }
      })
      if (!connectedRef.current.has(id)) return
      if (busyRef.current.has(id)) {
        pendingSessionConfigRef.current = withId(pendingSessionConfigRef.current, id)
        notify('sucesso', `Modelo trocado — entra a partir da próxima mensagem da fila: ${model}.`)
      } else {
        void stopSession(id, { silent: true })
        notify('sucesso', `Modelo trocado para a próxima mensagem: ${model}.`)
      }
    },
    [patchConv, stopSession, notify]
  )

  // Effort selector — same deferred-while-busy logic as the model picker.
  const changeEffort = useCallback(
    (id: string, effort: string): void => {
      patchConv(id, (c) => ({ ...c, effort }))
      if (!connectedRef.current.has(id)) return
      if (busyRef.current.has(id)) {
        pendingSessionConfigRef.current = withId(pendingSessionConfigRef.current, id)
        notify('sucesso', `Esforço trocado — entra a partir da próxima mensagem da fila: ${effort}.`)
      } else {
        void stopSession(id, { silent: true })
        notify('sucesso', `Esforço trocado para a próxima mensagem: ${effort}.`)
      }
    },
    [patchConv, stopSession, notify]
  )

  // onEvent (defined earlier in this component) reaches connect()/stopSession()
  // through these refs — see their declaration for why.
  connectRef.current = connect
  stopSessionRef.current = stopSession

  // "Permitir tudo" toggle — a global switch persisted across restarts and
  // applied to every live session. Lives in Settings; the topbar shows its status.
  const toggleSkipPerms = useCallback(
    (on: boolean): void => {
      setSkipPerms(on)
      void window.api.setConfig({ skipPermissions: on }) // persiste entre reinícios
      for (const id of connectedRef.current) void window.api.setBypass(id, on)
      if (on) setPermissions({})
      notify(
        on ? 'aviso' : 'sucesso',
        on
          ? 'Modo "permitir tudo" ativado — ferramentas não pedirão confirmação.'
          : 'Confirmações de permissão reativadas.'
      )
    },
    [notify]
  )

  // Independent high-risk gate for arbitrary Windows UI control. It is never
  // implied by "Permitir tudo" and main kills the native helper immediately on off.
  const toggleWindowsControl = useCallback(
    async (on: boolean): Promise<void> => {
      try {
        await window.api.setWindowsControlEnabled(on)
        setWindowsControlEnabled(on)
        notify(
          on ? 'aviso' : 'sucesso',
          on
            ? 'Controle do Windows ativado. O agente pode interagir com outros aplicativos.'
            : 'Controle do Windows desativado e ações pendentes interrompidas.'
        )
      } catch (error) {
        notify('erro', `Não foi possível alterar o controle do Windows: ${String(error)}`)
      }
    },
    [notify]
  )

  // "Modo econômico" toggle — per-conversation, same restart-on-idle logic as the
  // model/effort pickers. When on, the session receives instructions to skip
  // validation for trivial tasks (scoped to THIS conversation only).
  const changeEconomyMode = useCallback(
    (id: string, on: boolean): void => {
      const current = convsRef.current.find((c) => c.id === id)
      const cancelsLoop = on && current?.loopEnabled === true
      patchConv(id, (c) => ({ ...c, economyMode: on, ...(on ? { loopEnabled: false } : {}) }))
      if (connectedRef.current.has(id)) {
        if (cancelsLoop || !busyRef.current.has(id)) void stopSession(id, { silent: true })
        else pendingSessionConfigRef.current.add(id)
      }
      notify(
        'sucesso',
        on
          ? cancelsLoop
            ? 'Modo econômico ativado — o loop desta conversa foi interrompido e desativado.'
            : 'Modo econômico ativado para esta conversa — vale na próxima mensagem.'
          : 'Modo econômico desativado para esta conversa — vale na próxima mensagem.'
      )
    },
    [patchConv, stopSession, notify]
  )

  const changeLoopEnabled = useCallback(
    (id: string, on: boolean): void => {
      const current = convsRef.current.find((c) => c.id === id)
      if (on && current?.economyMode === true) return
      patchConv(id, (c) => ({ ...c, loopEnabled: on, ...(on ? { economyMode: false } : {}) }))
      // Disabling must destroy the SDK session even mid-turn: session-scoped
      // ScheduleWakeup jobs die with it, so no stale wakeup can resurrect work.
      if (connectedRef.current.has(id) && (!on || !busyRef.current.has(id))) {
        void stopSession(id, { silent: true })
      } else if (connectedRef.current.has(id)) {
        pendingSessionConfigRef.current.add(id)
      }
      notify(
        'sucesso',
        on
          ? 'Loop ativado para esta conversa — limite padrão de 100 ciclos.'
          : 'Loop desativado — continuações pendentes foram interrompidas.'
      )
    },
    [patchConv, stopSession, notify]
  )

  // "Modo rápido" (fast mode) toggle — per-conversation, same restart-on-idle
  // logic as the economy toggle. Only offered on models that support it; the
  // toggle is hidden otherwise, and switching to an unsupported model clears the
  // flag (see changeModel) so it can't silently ride along.
  const changeFastMode = useCallback(
    (id: string, on: boolean): void => {
      patchConv(id, (c) => (c.fastMode === on ? c : { ...c, fastMode: on }))
      if (connectedRef.current.has(id) && !busyRef.current.has(id)) {
        void stopSession(id, { silent: true })
      }
      notify(
        'sucesso',
        on
          ? 'Modo rápido ativado — respostas até ~2,5x mais rápidas, com custo por token maior. Vale na próxima mensagem.'
          : 'Modo rápido desativado — volta à velocidade e ao preço normais na próxima mensagem.'
      )
    },
    [patchConv, stopSession, notify]
  )

  // Core send into a SPECIFIC conversation, shared by the PC composer and by
  // commands arriving from a phone (remote inbound). `full` is what goes to the
  // agent (may include page-element refs); `text` is what's shown/used for title.
  const dispatch = useCallback(
    async (
      conv: Conversation,
      full: string,
      text: string,
      images: ImageAttachment[],
      thumbs: string[],
      files: FileAttachment[],
      fileRefs: FileRefAttachment[] = []
    ): Promise<void> => {
      // Project folder gone → don't process or send to the LLM; just warn.
      if (!busyRef.current.has(conv.id) && !(await ensureProject(conv))) return

      // Recuperação já parada (tentativas automáticas encerradas): nada mais vai
      // despachar a fila, então uma mensagem nova recomeça o fluxo — descarta o
      // cartão e segue o envio normal em vez de ficar presa na fila.
      const stalledRecovery = conv.recovery?.scheduledAt === 0
      if (stalledRecovery) patchConv(conv.id, (c) => ({ ...c, recovery: undefined }))

      // Agent already busy on THIS conversation → queue instead of sending, so
      // the running task isn't cancelled. It'll be dispatched when the turn ends.
      if (
        busyRef.current.has(conv.id) ||
        (conv.recovery && !stalledRecovery) ||
        queueRef.current.some((m) => m.convId === conv.id)
      ) {
        setQueue((q) => [...q, { id: uid('q'), convId: conv.id, full, text, images, thumbs, files, fileRefs }])
        return
      }

      // Reflect the send SYNCHRONOUSLY before any await: mark busy (so a second
      // concurrent send queues instead of starting a duplicate session) and show
      // the user's message immediately. Doing this before `await connect` is what
      // closes the connect-window race.
      const msgId = uid('u')
      interruptedRef.current.delete(conv.id) // fresh turn: clear any stale stop flag
      setBusy(conv.id, true)
      setBusySince((m) => ({ ...m, [conv.id]: Date.now() }))
      patchConv(conv.id, (c) => ({
        ...c,
        title: c.title === DEFAULT_TITLE && text.trim() ? deriveTitle(text) : c.title,
        messages: [
          ...c.messages,
          {
            kind: 'user',
            id: msgId,
            text,
            images: thumbs.length ? thumbs : undefined,
            files:
              files.length || fileRefs.length
                ? [...files, ...fileRefs].map((f) => ({ name: f.name, size: f.size }))
                : undefined,
            ts: Date.now()
          }
        ],
        updatedAt: Date.now()
      }))
      // Remember this as the in-flight message so a failing turn can mark it.
      const sdkUuid = crypto.randomUUID()
      inflightRef.current[conv.id] = { msgId, sdkUuid, full, images, files, fileRefs }

      try {
        // Lazily (re)start the agent for this conversation, resuming if possible.
        if (!connectedRef.current.has(conv.id)) await connect(conv)
        await window.api.sendMessage(conv.id, full, images, files, fileRefs, sdkUuid)
      } catch (err) {
        // Couldn't even reach the agent → keep the message, flag it with the error
        // and keep its payload so "Tentar de novo" can resend it.
        setBusy(conv.id, false)
        setBusySince((m) => withoutKey(m, conv.id))
        delete inflightRef.current[conv.id]
        failedRef.current[msgId] = { convId: conv.id, full, images, files, fileRefs }
        markMessageError(conv.id, msgId, `Falha ao enviar: ${String(err)}`)
        notify('erro', `Falha ao enviar: ${String(err)}`)
      }
    },
    [connect, patchConv, setBusy, notify, ensureProject, markMessageError]
  )

  const runRecovery = useCallback(
    async (convId: string, force = false): Promise<void> => {
      const conv = convsRef.current.find((c) => c.id === convId)
      const recovery = conv?.recovery
      if (!conv || !recovery || (!force && recovery.scheduledAt <= 0)) return
      if (!(await ensureProject(conv))) {
        patchConv(convId, (c) => ({ ...c, recovery: undefined }))
        setBusy(convId, false)
        return
      }
      // Invalidate this timer before awaiting so reloads/state updates cannot
      // launch the same recovery twice.
      patchConv(convId, (c) =>
        c.recovery?.id === recovery.id ? { ...c, recovery: { ...c.recovery, scheduledAt: -1 } } : c
      )
      setBusy(convId, true)
      setBusySince((m) => ({ ...m, [convId]: Date.now() }))
      const continuation =
        'Continue exatamente de onde parou. A execução anterior foi interrompida por limite de uso ou erro transitório.'
      const msgId = recovery.messageId ?? uid('recovery-msg')
      const sdkUuid = crypto.randomUUID()
      inflightRef.current[convId] = {
        msgId,
        sdkUuid,
        full: continuation,
        images: [],
        files: [],
        fileRefs: []
      }
      if (recovery.messageId) clearMessageError(convId, recovery.messageId)
      try {
        if (!connectedRef.current.has(convId)) await connect(conv)
        await window.api.sendMessage(convId, continuation, [], [], [], sdkUuid, 'recovery')
      } catch (err) {
        const attempt = recovery.attempt + 1
        patchConv(convId, (c) => ({
          ...c,
          recovery: {
            ...recovery,
            id: uid('recovery'),
            reason: 'transient',
            attempt,
            scheduledAt: attempt >= MAX_GENERIC_RETRIES ? 0 : Date.now() + 60_000,
            errorText: String(err)
          }
        }))
        setBusy(convId, attempt < MAX_GENERIC_RETRIES)
        setBusySince((m) => withoutKey(m, convId))
      }
    },
    [clearMessageError, connect, ensureProject, patchConv, setBusy]
  )

  // Restore persisted recoveries after reload and keep exactly one timer per
  // conversation. A stale callback re-checks the recovery id in runRecovery.
  useEffect(() => {
    if (!hydrated) return
    const timers: ReturnType<typeof setTimeout>[] = []
    for (const conv of conversations) {
      const recovery = conv.recovery
      if (!recovery) continue
      if (recovery.scheduledAt > 0) {
        setBusy(conv.id, true)
        const delay = Math.max(0, recovery.scheduledAt - Date.now())
        timers.push(setTimeout(() => void runRecovery(conv.id), Math.min(delay, 2_147_483_647)))
      }
    }
    return () => timers.forEach(clearTimeout)
  }, [conversations, hydrated, runRecovery, setBusy])

  const sendMessage = useCallback(
    async (
      text: string,
      images: ImageAttachment[] = [],
      files: FileAttachment[] = [],
      fileRefs: FileRefAttachment[] = []
    ): Promise<void> => {
      const conv = getActive()
      if (!conv) return
      let full = text.trim()
      if (chipsRef.current.length) {
        const refs = chipsRef.current
          .map(
            (c, i) =>
              `[#${i + 1} ${c.tagName}${c.id ? '#' + c.id : ''}] aba: ${c.tabName || 'web'}\n` +
              `selector: ${c.selector}\ntext: ${c.text.slice(0, 400)}\nhtml: ${c.html.slice(0, 600)}`
          )
          .join('\n\n')
        full = `${full}\n\n--- Selected page elements ---\n${refs}`
      }
      if (!full && images.length === 0 && files.length === 0 && fileRefs.length === 0) return

      const thumbs = images.map((img) => `data:${img.mediaType};base64,${img.data}`)
      setChips([]) // chips were consumed into `full`
      await dispatch(conv, full, text, images, thumbs, files, fileRefs)
    },
    [dispatch]
  )

  // Resend a message whose turn failed. The bubble already exists, so we don't
  // add a new one — we clear its error, re-mark it as in-flight and send again,
  // reusing the exact payload (text + attachments) captured when it failed.
  const retryMessage = useCallback(
    async (convId: string, msgId: string): Promise<void> => {
      const conv = convsRef.current.find((c) => c.id === convId)
      if (!conv) return
      if (busyRef.current.has(convId)) return // a turn is already running here
      const msg = conv.messages.find((m) => m.kind === 'user' && m.id === msgId)
      if (!msg || msg.kind !== 'user') return
      const payload = failedRef.current[msgId]
      const full = payload?.full ?? msg.text
      const images = payload?.images ?? []
      const files = payload?.files ?? []
      const fileRefs = payload?.fileRefs ?? []

      // Project folder gone → keep the error, just warn (ensureProject toasts).
      if (!(await ensureProject(conv))) return

      clearMessageError(convId, msgId)
      // O reenvio manual assume o lugar da recuperação automática — o cartão sai
      // da tela junto com o erro da bolha.
      patchConv(convId, (c) => (c.recovery ? { ...c, recovery: undefined } : c))
      interruptedRef.current.delete(convId) // fresh turn: clear any stale stop flag
      setBusy(convId, true)
      setBusySince((m) => ({ ...m, [convId]: Date.now() }))
      const sdkUuid = crypto.randomUUID()
      inflightRef.current[convId] = { msgId, sdkUuid, full, images, files, fileRefs }
      delete failedRef.current[msgId]

      try {
        if (!connectedRef.current.has(convId)) await connect(conv)
        await window.api.sendMessage(convId, full, images, files, fileRefs, sdkUuid)
      } catch (err) {
        setBusy(convId, false)
        setBusySince((m) => withoutKey(m, convId))
        delete inflightRef.current[convId]
        failedRef.current[msgId] = { convId, full, images, files, fileRefs }
        markMessageError(convId, msgId, `Falha ao enviar: ${String(err)}`)
        notify('erro', `Falha ao enviar: ${String(err)}`)
      }
    },
    [connect, ensureProject, patchConv, setBusy, notify, clearMessageError, markMessageError]
  )

  // Persist a composer draft onto a SPECIFIC conversation (debounced save keeps
  // it across switches and restarts). No-op write when unchanged.
  //
  // Takes an explicit `convId` rather than reading "whichever conversation is
  // active right now" — the Composer only calls this on blur / conversation
  // switch / send (not on every keystroke, which used to cause a full App
  // re-render per letter). By the time a switch-triggered flush runs, the
  // active conversation may already be the NEW one, so an implicit "current
  // active" target would silently write the outgoing draft onto the wrong
  // conversation (or lose it). The explicit id keeps the write correct.
  const onDraftChange = useCallback(
    (convId: string, text: string): void => {
      patchConv(convId, (c) => (c.draft === text ? c : { ...c, draft: text }))
    },
    [patchConv]
  )

  // Commands arriving from a phone (phone → PC → Claude Code): route into the
  // matching conversation via the same dispatch path the composer uses.
  useEffect(() => {
    const off = window.api.onRemoteInbound(({ convId, text, images }) => {
      const conv = convsRef.current.find((c) => c.id === convId)
      if (!conv) {
        notify('aviso', 'Comando remoto para uma conversa inexistente foi ignorado.')
        return
      }
      const imgs = images ?? []
      const thumbs = imgs.map((img) => `data:${img.mediaType};base64,${img.data}`)
      void dispatch(conv, text, text, imgs, thumbs, [])
    })
    return off
  }, [dispatch, notify])

  // A phone flipped "Permitir tudo" — apply it on the PC (persist + live sessions).
  useEffect(() => {
    const off = window.api.onRemoteSetSkipPerms(({ on }) => toggleSkipPerms(on))
    return off
  }, [toggleSkipPerms])

  // A phone changed a conversation's model/effort — apply with the same rules as
  // the PC pickers (restart-on-idle; ignored while the conversation is busy).
  useEffect(() => {
    const off = window.api.onRemoteSetModel(({ convId, model, effort }) => {
      const conv = convsRef.current.find((c) => c.id === convId)
      if (!conv || busyRef.current.has(convId)) return
      if (model && model !== conv.model) changeModel(convId, model)
      if (effort && effort !== conv.effort) changeEffort(convId, effort)
    })
    return off
  }, [changeModel, changeEffort])

  useEffect(() => {
    return window.api.onRemoteRecoveryAction(({ convId, action }) => {
      if (action === 'retry') void runRecovery(convId, true)
      else {
        patchConv(convId, (c) => ({ ...c, recovery: undefined }))
        setBusy(convId, false)
        setBusySince((m) => withoutKey(m, convId))
      }
    })
  }, [patchConv, runRecovery, setBusy])

  const deleteQueued = useCallback((id: string): void => {
    setQueue((q) => q.filter((m) => m.id !== id))
  }, [])

  const retryRecoveryNow = useCallback((): void => {
    const id = activeIdRef.current
    if (id) void runRecovery(id, true)
  }, [runRecovery])

  const cancelRecovery = useCallback((): void => {
    const id = activeIdRef.current
    if (!id) return
    patchConv(id, (c) => ({ ...c, recovery: undefined }))
    setBusy(id, false)
    setBusySince((m) => withoutKey(m, id))
  }, [patchConv, setBusy])

  // Shared by desktop answers AND phone answers (routed back via
  // onRemotePermissionResponse) so both sides clear their local modal state no
  // matter which one actually answered first.
  const respondToPermission = useCallback(
    async (convId: string, res: PermissionResponse): Promise<void> => {
      await window.api.respondPermission(convId, res)
      setPermissions((p) => withoutKey(p, convId))
      setMinimizedQuestions((m) => withoutKey(m, convId))
    },
    []
  )

  const respond = useCallback(
    async (behavior: 'allow' | 'deny', always: boolean): Promise<void> => {
      const cid = activeId
      if (!cid) return
      const req = permissions[cid]
      if (!req) return
      await respondToPermission(cid, { id: req.id, behavior, always })
    },
    [activeId, permissions, respondToPermission]
  )

  // Answer an AskUserQuestion: the user's picks go back to the model as the
  // tool's reply (main turns `answers` into the tool result).
  const answerQuestion = useCallback(
    async (answers: QuestionAnswer[]): Promise<void> => {
      const cid = activeId
      if (!cid) return
      const req = permissions[cid]
      if (!req) return
      await respondToPermission(cid, { id: req.id, behavior: 'allow', answers })
    },
    [activeId, permissions, respondToPermission]
  )

  // A phone answered a pending permission/question — resolve it the same way a
  // desktop answer would, so both sides' modals close in sync.
  useEffect(() => {
    return window.api.onRemotePermissionResponse(({ convId, res }) => {
      void respondToPermission(convId, res)
    })
  }, [respondToPermission])

  // Toggle whether the active conversation's pending question is minimized
  // (hidden, chip visible in ChatPanel) — used for outside-click/Esc AND the
  // chip's own click to reopen. Never touches `permissions`, so the question
  // itself is never lost/canceled by this.
  const setQuestionMinimized = useCallback((minimized: boolean): void => {
    const cid = activeIdRef.current
    if (!cid) return
    setMinimizedQuestions((m) => ({ ...m, [cid]: minimized }))
  }, [])

  // Voice features need an OpenAI key. When missing, open Settings on that field.
  const needVoiceKey = useCallback((): void => {
    notify('aviso', 'Adicione sua API key da OpenAI nas Configurações para usar voz.')
    setSettingsFocus('openai')
    setSettingsOpen(true)
  }, [notify])

  // Close Settings and re-read whether an OpenAI key now exists.
  const closeSettings = useCallback((): void => {
    setSettingsOpen(false)
    setSettingsFocus(null)
    void window.api.getConfig().then((c) => {
      setVoiceReady(!!c.openai?.apiKey?.trim())
      setOllamaReady(!!c.ollama?.enabled && !!c.ollama?.apiKey?.trim())
      voiceSpeedRef.current = c.openai?.speed || 1
    })
    void window.api.codexStatus().then((s) => setCodexReady(s.connected))
  }, [])

  // Stop any read-aloud in progress and invalidate its pending synthesis.
  const stopSpeak = useCallback((): void => {
    speakTokenRef.current++
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    setSpeakingId(null)
  }, [])

  // Play one base64 chunk to completion (or until cancelled). Resolves on end,
  // error, or when the audio is paused by stopSpeak.
  const playClip = (base64: string, mimeType: string): Promise<void> =>
    new Promise<void>((resolve) => {
      const audio = new Audio(`data:${mimeType};base64,${base64}`)
      // Speed is applied here (not at synthesis) so it's exact and instant.
      // preservesPitch keeps the voice natural instead of chipmunk/slowed.
      audio.playbackRate = voiceSpeedRef.current || 1
      audio.preservesPitch = true
      audioRef.current = audio
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      audio.onended = done
      audio.onerror = done
      audio.onpause = done // stopSpeak pauses → unblock the sequence
      audio.play().catch(done)
    })

  // Read an assistant answer aloud (TTS). Clicking again (or another message)
  // stops playback. The text is treated for speech, then synthesized and played
  // chunk-by-chunk so the first audio starts fast (the rest are prefetched).
  const toggleSpeak = useCallback(
    async (id: string, text: string): Promise<void> => {
      const wasThis = speakingId === id
      stopSpeak()
      if (wasThis) return // second click = stop
      if (!voiceReady) {
        needVoiceKey()
        return
      }
      const chunks = splitForSpeech(toSpeechText(text))
      if (chunks.length === 0) {
        notify('aviso', 'Não há texto para ler nesta resposta.')
        return
      }
      const token = ++speakTokenRef.current
      setSpeakingId(id)

      // Prefetch synthesis so chunk i+1 is ready while chunk i plays.
      const pending = new Map<number, ReturnType<typeof window.api.speak>>()
      const fetchChunk = (i: number): ReturnType<typeof window.api.speak> | null => {
        if (i < 0 || i >= chunks.length) return null
        if (!pending.has(i)) pending.set(i, window.api.speak(chunks[i]))
        return pending.get(i) ?? null
      }

      fetchChunk(0)
      for (let i = 0; i < chunks.length; i++) {
        const p = fetchChunk(i)
        fetchChunk(i + 1) // kick off the next one in parallel
        const r = await p!
        if (token !== speakTokenRef.current) return // cancelled while synthesizing
        if (!r.ok || !r.audioBase64) {
          stopSpeak()
          if (r.error === 'no-key') needVoiceKey()
          else notify('erro', `Falha ao gerar áudio: ${r.error ?? 'erro'}`)
          return
        }
        await playClip(r.audioBase64, r.mimeType ?? 'audio/mpeg')
        if (token !== speakTokenRef.current) return // stopped during playback
      }
      if (token === speakTokenRef.current) {
        audioRef.current = null
        setSpeakingId(null)
      }
    },
    [speakingId, voiceReady, needVoiceKey, notify, stopSpeak]
  )

  const tts = useMemo(() => ({ speakingId, onToggleSpeak: toggleSpeak }), [speakingId, toggleSpeak])

  const interrupt = useCallback((): void => {
    const cid = activeIdRef.current
    if (!cid) return
    // Stop the current task AND drop anything queued for this conversation. The
    // SDK ends an interrupt by emitting a `result` (not `error`); with the queue
    // cleared, the turn-end handler finds nothing to dispatch and just goes idle
    // instead of auto-starting the next queued message.
    interruptedRef.current.add(cid) // intentional stop — don't flag the message as failed
    setQueue((q) => q.filter((m) => m.convId !== cid))
    // The receipt tells us whether the in-flight SDK message actually survived
    // the Stop. Only paint it as canceled when the SDK confirms it will not run.
    const inflight = inflightRef.current[cid]
    void window.api
      .interrupt(cid)
      .then((receipt) => {
        const surviving = new Set(receipt.stillQueued.map((message) => message.messageId))
        patchConv(cid, (c) => ({
          ...c,
          queuedAfterInterrupt: receipt.stillQueued.length > 0 ? receipt.stillQueued : undefined,
          messages:
            inflight && !surviving.has(inflight.sdkUuid)
              ? c.messages.map((m) =>
                  m.kind === 'user' && m.id === inflight.msgId ? { ...m, canceled: true } : m
                )
              : c.messages
        }))
        if (receipt.stillQueued.length > 0) {
          notify(
            'aviso',
            `${receipt.stillQueued.length} mensagem(ns) sobreviveram ao Stop e ainda serão processadas.`
          )
        }
      })
      .catch(() => {
        if (!inflight) return
        patchConv(cid, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.kind === 'user' && m.id === inflight.msgId ? { ...m, canceled: true } : m
          )
        }))
      })
  }, [patchConv, notify])

  // Open a preview tab from the modal. newTab returns a status string, so we can
  // surface success/errors (e.g. Android failing because the toolchain is missing)
  // instead of failing silently.
  const openTab = useCallback(
    async (kind: TabKind): Promise<void> => {
      if (kind === 'android') notify('aviso', 'Abrindo Android… na 1ª vez pode baixar componentes.')
      try {
        const res = await window.api.newTab(kind)
        if (kind === 'web') return
        if (/ausente|não instalad|toolchain/i.test(res)) {
          notify('erro', 'Android ainda não instalado. Peça ao agente "instale as dependências do Android".')
        } else if (/não foi possível|incompleta|tempo esgotado|encerrou|virtualiza/i.test(res)) {
          notify('erro', res)
        } else {
          notify('sucesso', res)
        }
      } catch (e) {
        notify('erro', `Falha ao abrir aba: ${String(e)}`)
      }
    },
    [notify]
  )

  // ---- derived view state ----
  const active = conversations.find((c) => c.id === activeId) ?? null
  const activeConnected = activeId !== null && connectedIds.has(activeId)
  const showBusy = activeId !== null && busyIds.has(activeId)
  const activePermission = activeId ? permissions[activeId] : undefined
  const questionMinimized = activeId ? !!minimizedQuestions[activeId] : false
  const messages = active?.messages ?? []
  const tokens = active?.tokens ?? EMPTY_TOKENS
  const activeQueue = active ? queue.filter((m) => m.convId === active.id) : []
  const runningSince = activeId ? busySince[activeId] ?? null : null
  const lastDurationMs = activeId ? lastDuration[activeId] ?? null : null

  // ---- agents panel (supervisor view) ----
  const activeTracks = useMemo(() => (activeId ? tracks[activeId] ?? {} : {}), [tracks, activeId])
  const runningTrackCount = useMemo(
    () => Object.values(activeTracks).filter((t) => t.status === 'running').length,
    [activeTracks]
  )
  /** Every conversation stuck waiting on the user — the supervisor's real lever. */
  const pendingPermissionList = useMemo(
    () =>
      Object.entries(permissions).map(([convId, request]) => ({
        convId,
        title: conversations.find((c) => c.id === convId)?.title ?? 'Conversa',
        request
      })),
    [permissions, conversations]
  )
  // The right-hand pane holds ONE of two tabs (browser / agents); `agentsOpen`
  // is the selected tab and `browserMinimized` collapses the whole pane.
  const openAgentsPanel = useCallback((): void => {
    setAgentsOpen(true)
    setBrowserMinimized(false)
  }, [])
  const selectRightPane = useCallback((pane: 'browser' | 'agents'): void => {
    setAgentsOpen(pane === 'agents')
    setBrowserMinimized(false)
  }, [])

  // ---- project map ----
  // The tree is only scanned once the panel is actually open: it walks the disk,
  // and doing it for every conversation switch in the background would be work
  // nobody asked for.
  const activeCwd = active?.cwd ?? ''
  const [projectTree, setProjectTree] = useState<ProjectTree>({
    nodes: [],
    truncated: false,
    missing: []
  })
  // Paths currently on the map, sent along on each re-read so the main process
  // can answer which of them were actually DELETED (vs. merely pushed out of
  // the "most recent" ranking) — the map animates destruction only for those.
  const shownPaths = useRef<string[]>([])
  useEffect(() => {
    shownPaths.current = projectTree.nodes.filter((n) => !n.isDir).map((n) => n.path)
  }, [projectTree])

  const touchCount = active ? active.messages.length : 0
  useEffect(() => {
    if (!agentsOpen || !activeCwd) return
    let alive = true
    // Re-read shortly after activity settles: a file the agent just created or
    // deleted should show up without the user having to reopen the panel.
    const run = (): void => {
      void window.api.projectTree(activeCwd, shownPaths.current).then((t) => {
        if (alive) setProjectTree(t)
      })
    }
    const id = setTimeout(run, shownPaths.current.length ? 1200 : 0)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [agentsOpen, activeCwd, touchCount])

  const projectName = useMemo(
    () => activeCwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'projeto',
    [activeCwd]
  )
  /** The map reads the SAME messages the chat renders — no second store. */
  const activeTouches = useMemo(
    () => (active ? fileTouches(active.messages, active.cwd) : []),
    [active]
  )

  /** The user's messages that produced work — the map's step-by-step filter. */
  const activeTurns = useMemo(
    () => (active ? turnsOf(active.messages, activeTouches) : []),
    [active, activeTouches]
  )

  const projects = useMemo<SidebarProject[]>(() => {
    const map = new Map<string, Conversation[]>()
    for (const c of conversations) {
      const arr = map.get(c.cwd)
      if (arr) arr.push(c)
      else map.set(c.cwd, [c])
    }
    const recency = (cs: Conversation[]): number => Math.max(...cs.map((c) => c.updatedAt))
    return [...map.entries()]
      .map(([path, cs]) => ({
        path,
        name: basename(path),
        conversations: [...cs].sort((a, b) => b.updatedAt - a.updatedAt)
      }))
      .sort((a, b) => recency(b.conversations) - recency(a.conversations))
  }, [conversations])

  const recents = useMemo<Conversation[]>(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 15),
    [conversations]
  )

  const selectProjectFolder = async (): Promise<void> => {
    if (!active) return
    const directory = await window.api.pickDirectory()
    if (!directory) return
    const valid = await window.api.pathExists(directory)
    if (!valid) {
      notify('erro', 'A pasta selecionada não está disponível.')
      return
    }
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === active.id ? { ...conversation, cwd: directory, updatedAt: Date.now() } : conversation
      )
    )
    setProjectMissing(false)
  }

  if (storageLoadError && (!hydrated || storageStatus?.writable === false)) {
    return (
      <div className="storage-recovery" role="alert">
        <div className="storage-recovery-card">
          <h1>Persistência indisponível</h1>
          <p>{storageLoadError}</p>
          <p>
            O backend selecionado continua sendo <strong>{storageStatus?.backend ?? 'desconhecido'}</strong>.
            O SQLite local não foi usado como fallback e nenhuma lista vazia foi assumida.
          </p>
          <div className="modal-actions">
            {storageStatus?.backend === 'postgres' && (
              <button
                className="btn primary"
                type="button"
                onClick={() => {
                  void window.api.retryStorage()
                    .then(() => window.dispatchEvent(new Event('agent-code-request-reload')))
                    .catch((error) =>
                      setStorageLoadError(ipcErrorMessage(error, 'A reconexão falhou.'))
                    )
                }}
              >
                Tentar novamente
              </button>
            )}
            <button className="btn ghost" type="button" onClick={() => setSettingsOpen(true)}>
              Corrigir configuração
            </button>
          </div>
        </div>
        {settingsOpen && (
          <SettingsModal
            onClose={closeSettings}
            focus={settingsFocus}
            skipPerms={skipPerms}
            onToggleSkipPerms={toggleSkipPerms}
            windowsControlEnabled={windowsControlEnabled}
            onToggleWindowsControl={(on) => void toggleWindowsControl(on)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        projects={projects}
        recents={recents}
        activeId={activeId}
        busyIds={busyIds}
        onSelect={selectConversation}
        onNewChat={newChat}
        onNewProject={newProject}
        onNewChatIn={newChatIn}
        onRename={renameConversation}
        onDelete={deleteConversation}
        onSelectResult={selectConversationAt}
      />

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-left">
          <div className="project readonly" title={active?.cwd || ''}>
            <span className="project-label">Projeto</span>
            <span className="project-path">{active ? basename(active.cwd) : 'Nenhuma conversa'}</span>
          </div>
          {active && (
            <button
              className="btn ghost editor-btn"
              title={`Abrir no VS Code · ${basename(active.cwd)}`}
              onClick={async () => {
                const r = await window.api.openInEditor(active.cwd)
                notify(r.ok ? 'sucesso' : 'erro', r.message)
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="#0098FF"
                  d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"
                />
              </svg>
            </button>
          )}
          {active && (
            <button
              className="btn ghost editor-btn"
              title={`Abrir a pasta no explorador · ${basename(active.cwd)}`}
              onClick={async () => {
                const r = await window.api.openInFolder(active.cwd)
                notify(r.ok ? 'sucesso' : 'erro', r.message)
              }}
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            </button>
          )}
          </div>
          <UsageBadge limits={usageLimits} providers={usageProviders} onProvidersChange={setUsageProviders} />
          {/* Acesso permanente ao painel de agentes: sem isso ele só existiria
              enquanto houvesse subagente rodando, e não daria pra rever nada. */}
          <button
            className={`btn ghost agents-btn topbar-right${agentsOpen ? ' on' : ''}${
              runningTrackCount > 0 ? ' live' : ''
            }`}
            onClick={() =>
              agentsOpen && !browserMinimized ? selectRightPane('browser') : openAgentsPanel()
            }
            title="Agentes: quem está trabalhando nesta conversa"
          >
            <IconUsers />
            {runningTrackCount > 0 && <span className="agents-btn-badge">{runningTrackCount}</span>}
          </button>
          <button
            className={`btn ghost remote-btn ${remoteRunning ? 'on' : ''}`}
            onClick={() => setRemoteOpen(true)}
            title="Controle remoto pelo celular (Android)"
          >
            <IconSmartphone />
            {remoteRunning && <span className="remote-dot" />}
          </button>
          <button
            className="btn ghost settings-btn"
            onClick={() => setSettingsOpen(true)}
            title="Configurações (voz, Ollama, pasta de dados, etc.)"
          >
            <IconSettings />
          </button>
          {active && activeConnected ? (
            <>
              <span className={`session-pill ${skipPerms ? 'danger' : ''}`}>
                ● {skipPerms ? 'tudo liberado' : 'conectado'}
              </span>
              <button
                className="btn ghost stop-session-btn"
                onClick={requestStopSession}
                title="Parar a sessão (encerra o agente e libera a troca de modelo)"
              >
                <IconPower />
                Parar sessão
              </button>
            </>
          ) : (
            // Shown even with no conversation: on first run it picks a folder,
            // creates the first chat and connects (see connectStart).
            <button className="btn primary" onClick={connectStart}>
              Conectar
            </button>
          )}
        </header>

        <div className="workspace" ref={workspaceRef}>
          <ChatPanel
            messages={messages}
            hasActive={!!active}
            busy={showBusy}
            windowsControlEnabled={windowsControlEnabled}
            onDisableWindowsControl={() => void toggleWindowsControl(false)}
            tokens={tokens}
            chips={chips}
            onRemoveChip={(i) => setChips((c) => c.filter((_, idx) => idx !== i))}
            onSend={sendMessage}
            onInterrupt={interrupt}
            onRetry={(msgId) => active && void retryMessage(active.id, msgId)}
            composerRef={composerRef}
            projects={projects}
            projectRoot={active?.cwd ?? null}
            convId={active?.id ?? null}
            scrollToId={scrollTarget && scrollTarget.convId === activeId ? scrollTarget.msgId : null}
            scrollSeq={scrollTarget?.seq ?? 0}
            draft={active?.draft ?? ''}
            onDraftChange={onDraftChange}
            projectMissing={projectMissing}
            projectMissingMsg={active ? `A pasta do projeto não existe mais: ${active.cwd}` : ''}
            onSelectProjectFolder={() => void selectProjectFolder()}
            queued={activeQueue}
            onDeleteQueued={deleteQueued}
            recovery={active?.recovery}
            onRetryRecovery={retryRecoveryNow}
            onCancelRecovery={cancelRecovery}
            runningSince={runningSince}
            lastDurationMs={lastDurationMs}
            onStart={connectStart}
            voiceReady={voiceReady}
            onNeedVoiceKey={needVoiceKey}
            tts={tts}
            models={modelsFor(models, active?.model)}
            model={active?.model ?? MODELS[0].id}
            modelLocked={!active}
            onModelChange={(m) => active && changeModel(active.id, m)}
            onModelLockedClick={() => notify('aviso', 'Selecione uma conversa para trocar o modelo.')}
            effortLevels={effortLevelsFor(active?.model)}
            effort={active?.effort ?? DEFAULT_EFFORT}
            effortLocked={!active}
            onEffortChange={(e) => active && changeEffort(active.id, e)}
            economyMode={active?.economyMode === true}
            onEconomyModeChange={(on) => active && changeEconomyMode(active.id, on)}
            loopEnabled={active?.loopEnabled === true}
            loopLocked={active?.economyMode === true}
            onLoopEnabledChange={(on) => active && changeLoopEnabled(active.id, on)}
            fastModeAvailable={!!active && modelSupportsFastMode(active.model)}
            fastMode={active?.fastMode === true}
            onFastModeChange={(on) => active && changeFastMode(active.id, on)}
            pendingQuestion={!!activePermission?.questions && questionMinimized}
            onReopenQuestion={() => setQuestionMinimized(false)}
            todoPlan={active?.todoPlan}
            backgroundTasks={active?.backgroundTasks ?? []}
            queuedAfterInterrupt={active?.queuedAfterInterrupt ?? []}
            runningAgents={runningTrackCount}
            onOpenAgents={openAgentsPanel}
          />
          {/* O divisor vale para o painel da direita inteiro (navegador ou agentes):
              sem ele, o mapa de fluxo ficava preso na largura padrão. */}
          {!browserMinimized && (
            <>
              <div
                className="splitter"
                onMouseDown={startBrowserDrag}
                title="Arraste para redimensionar o painel"
              />
              <div className="right-pane" style={{ flex: `0 0 ${browserWidth}px` }}>
                <RightPaneTabs
                  active={agentsOpen ? 'agents' : 'browser'}
                  onSelect={selectRightPane}
                  onCollapse={() => setBrowserMinimized(true)}
                  liveAgents={runningTrackCount}
                  browserTabs={browserState.tabs.length}
                />
                {agentsOpen ? (
                  <AgentsPanel
                    tracks={activeTracks}
                    busy={!!active && busyIds.has(active.id)}
                    busySince={active ? busySince[active.id] ?? null : null}
                    backgroundTasks={active?.backgroundTasks ?? []}
                    pendingPermissions={pendingPermissionList}
                    onFocusPermission={(convId) => {
                      setActiveId(convId)
                      setQuestionMinimized(false)
                      setAgentsOpen(false)
                    }}
                    loading={!hydrated}
                    onClose={() => setBrowserMinimized(true)}
                    projectEntries={projectTree.nodes}
                    projectTruncated={projectTree.truncated}
                    projectMissing={projectTree.missing}
                    projectSteps={active?.todoPlan?.items ?? []}
                    touches={activeTouches}
                    turns={activeTurns}
                    projectName={projectName}
                  />
                ) : (
                  <BrowserPanel
                    state={browserState}
                    minimized={false}
                    onToggleMinimize={() => setBrowserMinimized(true)}
                    onRequestNewTab={() => setNewTabOpen(true)}
                    onRequestPickFile={(tabId) => setFilePicker({ replaceTabId: tabId })}
                  />
                )}
              </div>
            </>
          )}
          {/* Rail: pane collapsed — one button per tab, so either is one click away. */}
          {browserMinimized && (
            <div className="right-rail">
              <button
                type="button"
                className="right-rail-btn"
                onClick={() => selectRightPane('browser')}
                title="Mostrar navegador"
              >
                <IconGlobe size={15} />
                Navegador
              </button>
              <button
                type="button"
                className={`right-rail-btn${runningTrackCount > 0 ? ' live' : ''}`}
                onClick={() => selectRightPane('agents')}
                title="Ver os agentes trabalhando"
              >
                <IconUsers size={15} />
                Agentes
                {runningTrackCount > 0 && <span className="rail-badge">{runningTrackCount}</span>}
              </button>
            </div>
          )}
        </div>
      </div>

      {activePermission &&
        (activePermission.questions ? (
          !questionMinimized && (
            <QuestionModal
              request={activePermission}
              onAnswer={answerQuestion}
              onCancel={() => respond('deny', false)}
              onMinimize={() => setQuestionMinimized(true)}
            />
          )
        ) : (
          <PermissionModal request={activePermission} onRespond={respond} />
        ))}
      {newTabOpen && (
        <NewTabModal
          onPick={(kind) => {
            setNewTabOpen(false)
            // A manual file tab opens the project file picker instead of a blank
            // tab; with no project folder there's nothing to browse, so fall back.
            if (kind === 'file') {
              if (active?.cwd) setFilePicker({})
              else void openTab('file')
              return
            }
            void openTab(kind)
          }}
          onClose={() => setNewTabOpen(false)}
        />
      )}
      {filePicker && active?.cwd && (
        <FilePickerModal
          root={active.cwd}
          onClose={() => setFilePicker(null)}
          onPick={(abs) => {
            const replaceId = filePicker.replaceTabId
            setFilePicker(null)
            const url = 'file:///' + abs.replace(/\\/g, '/').replace(/^\/+/, '')
            void window.api.newTab('file', url)
            if (replaceId) void window.api.closeTab(replaceId)
          }}
        />
      )}
      {remoteOpen && <RemoteModal onClose={() => setRemoteOpen(false)} />}
      {settingsOpen && (
        <SettingsModal
          onClose={closeSettings}
          focus={settingsFocus}
          skipPerms={skipPerms}
          onToggleSkipPerms={toggleSkipPerms}
          windowsControlEnabled={windowsControlEnabled}
          onToggleWindowsControl={(on) => void toggleWindowsControl(on)}
        />
      )}
      {stopConfirm && (
        <div className="modal-overlay" onClick={() => setStopConfirm(null)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="modal-title">Parar a execução do agente?</h3>
            <p className="modal-message">
              O agente está executando uma tarefa agora. Parar a sessão vai interromper essa
              execução e encerrar o agente. Você poderá reconectar depois (a conversa é mantida).
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setStopConfirm(null)}>
                Continuar executando
              </button>
              <button
                className="btn danger-btn"
                onClick={() => {
                  const id = stopConfirm
                  setStopConfirm(null)
                  void stopSession(id)
                }}
              >
                Parar execução
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
