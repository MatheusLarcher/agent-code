import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type {
  AgentEventMsg,
  BrowserState,
  ChatEvent,
  FileAttachment,
  ImageAttachment,
  PermissionRequest,
  PickedElement,
  QuestionAnswer,
  TabKind
} from '@shared/ipc'
import { isOllamaModel, OLLAMA_MODELS } from '@shared/ipc'
import type { Conversation, UIMessage } from './types'
import { DEFAULT_TITLE } from './types'
import { loadConversations, loadUi, saveConversations, saveUi } from './storage'
import { ChatPanel } from './components/ChatPanel'
import { BrowserPanel } from './components/BrowserPanel'
import { Sidebar, type SidebarProject } from './components/Sidebar'
import { IconPower, IconSettings, IconSmartphone } from './components/Icons'
import { useUI } from './ui/UiProvider'
import { PermissionModal } from './ui/PermissionModal'
import { QuestionModal } from './ui/QuestionModal'
import { splitForSpeech, toSpeechText } from '@shared/speechText'
import { NewTabModal } from './ui/NewTabModal'
import { RemoteModal } from './ui/RemoteModal'
import { SettingsModal } from './ui/SettingsModal'

export type { UserMessage, UIMessage } from './types'

const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]

const EMPTY_TOKENS = { context: 0, output: 0, cost: 0 }

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
function reduceMessages(prev: UIMessage[], e: ChatEvent): UIMessage[] {
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
  return [...prev, e as UIMessage]
}

export function App(): JSX.Element {
  const { notify } = useUI()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [browserMinimized, setBrowserMinimized] = useState(false)
  const [browserWidth, setBrowserWidth] = useState(720)
  const [hydrated, setHydrated] = useState(false)
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
  const [permissions, setPermissions] = useState<Record<string, PermissionRequest>>({})
  const [chips, setChips] = useState<PickedElement[]>([])
  // Whether the "new preview tab" modal is open (rendered at the app root so it
  // isn't clipped by the horizontally-scrolling tab strip).
  const [newTabOpen, setNewTabOpen] = useState(false)
  // Remote control (phone bridge): modal open + whether the LAN bridge is up
  // (gates publishing conversation snapshots to main for phones to read).
  const [remoteOpen, setRemoteOpen] = useState(false)
  const [remoteRunning, setRemoteRunning] = useState(false)
  // App settings modal (Google Stitch / OpenAI API keys, etc.).
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
  // Models offered in the selector: Claude always, Ollama Cloud when configured.
  const models = useMemo(() => (ollamaReady ? [...MODELS, ...OLLAMA_MODELS] : MODELS), [ollamaReady])
  // Read-aloud speed (config), applied as the audio playbackRate (deterministic).
  const voiceSpeedRef = useRef(1)
  // Read-aloud (TTS): id of the message currently playing, and the <audio> in use.
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  // Bumped to cancel an in-flight read-aloud sequence (stop / switch message).
  const speakTokenRef = useRef(0)
  // Stitch tabs already approved ("Aplicar no projeto" clicked) — hides the bar.
  const [appliedStitch, setAppliedStitch] = useState<Set<string>>(new Set())
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

  // The message currently in flight per conversation (the user bubble awaiting a
  // response), so a failing turn can mark exactly that message as errored.
  const inflightRef = useRef<
    Record<string, { msgId: string; full: string; images: ImageAttachment[]; files: FileAttachment[] }>
  >({})
  // Payloads of messages whose turn failed, kept (in memory) so "Tentar de novo"
  // resends the exact same text + attachments. Keyed by message id.
  const failedRef = useRef<
    Record<string, { convId: string; full: string; images: ImageAttachment[]; files: FileAttachment[] }>
  >({})
  // Conversations the user just interrupted/stopped — their next `result` is an
  // intentional stop, not a failure, so we must not flag the message as errored.
  const interruptedRef = useRef<Set<string>>(new Set())

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
        if (e.kind === 'result' && e.usage) {
          const u = e.usage
          next = {
            ...next,
            tokens: {
              // Real context-window size of the last model request (not the
              // per-turn sum); falls back to the old computation if absent.
              context: e.contextTokens ?? u.input + u.cacheRead + u.cacheWrite,
              output: c.tokens.output + u.output,
              cost: c.tokens.cost + (e.costUsd ?? 0)
            }
          }
        }
        return next
      })

      if (e.kind === 'result' || e.kind === 'error') {
        // A finished turn has no outstanding permission request — clear any so a
        // stale modal can't reappear when this conversation becomes active again.
        setPermissions((p) => withoutKey(p, cid))

        // Did the user just stop this turn? A user interrupt/stop ends with a
        // `result` (sometimes flagged is_error); that's intentional, not a failure.
        const wasInterrupted = interruptedRef.current.delete(cid)
        // A failed turn = a fatal session error, or a result the model flagged as
        // an error and that the user did NOT cause by stopping it. The user's
        // message must stay in the chat, marked with the error + a retry button.
        const failed = e.kind === 'error' || (e.kind === 'result' && e.isError && !wasInterrupted)

        if (e.kind === 'result' && !e.isError) setLastDuration((m) => ({ ...m, [cid]: e.durationMs }))

        if (failed) {
          // Pin the error onto the in-flight message and keep its payload so the
          // user can resend it as-is. Drop the queue (it won't be dispatched) and
          // stop the busy timer.
          const inflight = inflightRef.current[cid]
          if (inflight) {
            failedRef.current[inflight.msgId] = {
              convId: cid,
              full: inflight.full,
              images: inflight.images,
              files: inflight.files
            }
            markMessageError(cid, inflight.msgId, e.text || 'A resposta falhou. Tente de novo.')
          }
          delete inflightRef.current[cid]
          setBusy(cid, false)
          setBusySince((m) => withoutKey(m, cid))

          // Anything still queued for this conversation won't be dispatched now —
          // turn each into its own errored bubble (with retry) so no typed message
          // is silently lost.
          const stillQueued = queueRef.current.filter((m) => m.convId === cid)
          if (stillQueued.length) {
            setQueue((cur) => cur.filter((m) => m.convId !== cid))
            patchConv(cid, (c) => ({
              ...c,
              messages: [
                ...c.messages,
                ...stillQueued.map((q) => ({
                  kind: 'user' as const,
                  id: q.id, // reuse the queue id so retry can find it
                  text: q.text,
                  images: q.thumbs.length ? q.thumbs : undefined,
                  files: q.files.length ? q.files.map((f) => ({ name: f.name, size: f.size })) : undefined,
                  error: 'A conversa encerrou antes de enviar esta mensagem.'
                }))
              ],
              updatedAt: Date.now()
            }))
            for (const q of stillQueued) {
              failedRef.current[q.id] = { convId: cid, full: q.full, images: q.images, files: q.files }
            }
          }

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
                files: next.files.length ? next.files.map((f) => ({ name: f.name, size: f.size })) : undefined
              }
            ],
            updatedAt: Date.now()
          }))
          inflightRef.current[cid] = { msgId: nextMsgId, full: next.full, images: next.images, files: next.files }
          void window.api.sendMessage(cid, next.full, next.images, next.files)
          setBusySince((m) => ({ ...m, [cid]: Date.now() })) // restart timer for the next turn
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
      // A background conversation's permission modal isn't visible (only the
      // active one renders) — toast so the user knows that chat is waiting,
      // otherwise its session (and queue) would silently freeze.
      if (convId !== activeIdRef.current) {
        const title = convsRef.current.find((c) => c.id === convId)?.title ?? 'Outra conversa'
        const what = req.questions ? 'uma resposta' : 'uma permissão'
        notify('aviso', `“${title}” está aguardando ${what}.`)
      }
    })
    const offState = window.api.onBrowserState(setBrowserState)
    const offPicked = window.api.onBrowserPicked((el) => {
      setChips((c) => [...c, el])
      composerRef.current?.focus()
    })
    return () => {
      offEvent()
      offPerm()
      offState()
      offPicked()
    }
  }, [onEvent])

  // ---- load persisted history once (async: SQLite via main, migrates localStorage) ----
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [loaded, ui] = await Promise.all([loadConversations(), loadUi()])
      if (cancelled) return
      setConversations(loaded)
      setCollapsed(ui.collapsed)
      setBrowserMinimized(ui.browserMinimized)
      setBrowserWidth(ui.browserWidth)
      setActiveId(
        ui.activeId && loaded.some((c) => c.id === ui.activeId) ? ui.activeId : loaded[0]?.id ?? null
      )
      setHydrated(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Load persisted app config once (e.g. the "Permitir tudo" toggle).
  useEffect(() => {
    void window.api.getConfig().then((c) => {
      skipPermsRef.current = c.skipPermissions
      setSkipPerms(c.skipPermissions)
      setVoiceReady(!!c.openai?.apiKey?.trim())
      setOllamaReady(!!c.ollama?.enabled && !!c.ollama?.apiKey?.trim())
      voiceSpeedRef.current = c.openai?.speed || 1
    })
  }, [])

  // Tell main which conversation's browser the panel should show, so each chat
  // gets its own independent browser instance.
  useEffect(() => {
    if (hydrated) void window.api.setActiveBrowser(activeId)
  }, [activeId, hydrated])

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
  useEffect(() => {
    if (!hydrated) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveConversations(convsRef.current), 400)
    return () => clearTimeout(saveTimer.current)
  }, [conversations, hydrated])
  useEffect(() => {
    if (hydrated) void saveUi({ collapsed, activeId, browserMinimized, browserWidth })
  }, [collapsed, activeId, browserMinimized, browserWidth, hydrated])

  // Flush conversations (incl. the current draft) right away if the app is closing
  // within the save debounce window — so a just-typed draft isn't lost on exit.
  useEffect(() => {
    const flush = (): void => void saveConversations(convsRef.current)
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

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
          messages: c.messages
        }))
      })
    }, 400)
    return () => clearTimeout(pubTimer.current)
  }, [conversations, busyIds, connectedIds, remoteRunning, hydrated])

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
      const w = Math.max(340, Math.min(rect.width - 440, rect.right - ev.clientX))
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
    // New conversations in a known project inherit that project's model; otherwise
    // fall back to the active conversation's model.
    const sameFolderModel = convsRef.current.find((c) => c.cwd === folder)?.model
    const conv: Conversation = {
      id: uid('c'),
      title: DEFAULT_TITLE,
      cwd: folder,
      model: sameFolderModel || getActive()?.model || MODELS[0].id,
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
        // Ollama models authenticate with the Ollama API key (handled in main), so
        // they skip the Anthropic login entirely.
        const { authenticated } = isOllamaModel(conv.model)
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
        await window.api.startAgent({
          convId: conv.id,
          cwd: conv.cwd,
          model: conv.model,
          skipPermissions: skipPermsRef.current,
          resume: conv.sdkSessionId ?? undefined
        })
        setConnected(conv.id, true)
        setPermissions((pp) => withoutKey(pp, conv.id))
      })()
      connectingRef.current.set(conv.id, p)
      void p.finally(() => connectingRef.current.delete(conv.id))
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
    async (id: string): Promise<void> => {
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
      notify('sucesso', 'Sessão encerrada — agora você pode trocar o modelo.')
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

  // "Permitir tudo" toggle — a global switch persisted across restarts and
  // applied to every live session. Shared by the topbar and the composer bar.
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
      files: FileAttachment[]
    ): Promise<void> => {
      // Project folder gone → don't process or send to the LLM; just warn.
      if (!busyRef.current.has(conv.id) && !(await ensureProject(conv))) return

      // Agent already busy on THIS conversation → queue instead of sending, so
      // the running task isn't cancelled. It'll be dispatched when the turn ends.
      if (busyRef.current.has(conv.id)) {
        setQueue((q) => [...q, { id: uid('q'), convId: conv.id, full, text, images, thumbs, files }])
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
            files: files.length ? files.map((f) => ({ name: f.name, size: f.size })) : undefined
          }
        ],
        updatedAt: Date.now()
      }))
      // Remember this as the in-flight message so a failing turn can mark it.
      inflightRef.current[conv.id] = { msgId, full, images, files }

      try {
        // Lazily (re)start the agent for this conversation, resuming if possible.
        if (!connectedRef.current.has(conv.id)) await connect(conv)
        await window.api.sendMessage(conv.id, full, images, files)
      } catch (err) {
        // Couldn't even reach the agent → keep the message, flag it with the error
        // and keep its payload so "Tentar de novo" can resend it.
        setBusy(conv.id, false)
        setBusySince((m) => withoutKey(m, conv.id))
        delete inflightRef.current[conv.id]
        failedRef.current[msgId] = { convId: conv.id, full, images, files }
        markMessageError(conv.id, msgId, `Falha ao enviar: ${String(err)}`)
        notify('erro', `Falha ao enviar: ${String(err)}`)
      }
    },
    [connect, patchConv, setBusy, notify, ensureProject, markMessageError]
  )

  const sendMessage = useCallback(
    async (text: string, images: ImageAttachment[] = [], files: FileAttachment[] = []): Promise<void> => {
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
      if (!full && images.length === 0 && files.length === 0) return

      const thumbs = images.map((img) => `data:${img.mediaType};base64,${img.data}`)
      setChips([]) // chips were consumed into `full`
      await dispatch(conv, full, text, images, thumbs, files)
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

      // Project folder gone → keep the error, just warn (ensureProject toasts).
      if (!(await ensureProject(conv))) return

      clearMessageError(convId, msgId)
      interruptedRef.current.delete(convId) // fresh turn: clear any stale stop flag
      setBusy(convId, true)
      setBusySince((m) => ({ ...m, [convId]: Date.now() }))
      inflightRef.current[convId] = { msgId, full, images, files }
      delete failedRef.current[msgId]

      try {
        if (!connectedRef.current.has(convId)) await connect(conv)
        await window.api.sendMessage(convId, full, images, files)
      } catch (err) {
        setBusy(convId, false)
        setBusySince((m) => withoutKey(m, convId))
        delete inflightRef.current[convId]
        failedRef.current[msgId] = { convId, full, images, files }
        markMessageError(convId, msgId, `Falha ao enviar: ${String(err)}`)
        notify('erro', `Falha ao enviar: ${String(err)}`)
      }
    },
    [connect, ensureProject, setBusy, notify, clearMessageError, markMessageError]
  )

  // Persist the composer draft onto the active conversation (debounced save keeps
  // it across switches and restarts). No-op write when unchanged.
  const onDraftChange = useCallback(
    (text: string): void => {
      const id = activeIdRef.current
      if (!id) return
      patchConv(id, (c) => (c.draft === text ? c : { ...c, draft: text }))
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

  const deleteQueued = useCallback((id: string): void => {
    setQueue((q) => q.filter((m) => m.id !== id))
  }, [])

  const respond = useCallback(
    async (behavior: 'allow' | 'deny', always: boolean): Promise<void> => {
      const cid = activeId
      if (!cid) return
      const req = permissions[cid]
      if (!req) return
      await window.api.respondPermission(cid, { id: req.id, behavior, always })
      setPermissions((p) => withoutKey(p, cid))
    },
    [activeId, permissions]
  )

  // Answer an AskUserQuestion: the user's picks go back to the model as the
  // tool's reply (main turns `answers` into the tool result).
  const answerQuestion = useCallback(
    async (answers: QuestionAnswer[]): Promise<void> => {
      const cid = activeId
      if (!cid) return
      const req = permissions[cid]
      if (!req) return
      await window.api.respondPermission(cid, { id: req.id, behavior: 'allow', answers })
      setPermissions((p) => withoutKey(p, cid))
    },
    [activeId, permissions]
  )

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
    void window.api.interrupt(cid)
  }, [])

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

  // Approve/reject a Google Stitch design shown in the preview. The decision is
  // sent into the active conversation as a normal message, so the agent either
  // implements the design into the project (approve) or holds off (reject).
  const decideStitch = useCallback(
    (decision: 'apply' | 'discard'): void => {
      const conv = getActive()
      if (!conv) return
      const stitchTab = browserState.tabs.find((t) => t.active && t.kind === 'stitch')
      if (decision === 'apply') {
        // Hide the bar right away — the design was approved.
        if (stitchTab) setAppliedStitch((s) => withId(s, stitchTab.id))
        void dispatch(
          conv,
          'O usuário aprovou o design exibido no preview do Stitch (clicou em "Aplicar no projeto"). ' +
            'Aplique-o agora ATENDENDO ao que ele pediu nesta conversa — pode ser criar uma tela nova, ' +
            'reformular/atualizar o visual de uma tela ou componente já existente, ou qualquer outra ' +
            'alteração que ele tenha solicitado. NÃO cole o HTML cru do Stitch: ADAPTE o visual (layout, ' +
            'cores, tipografia, espaçamentos, componentes) à stack, à estrutura e às convenções do projeto, ' +
            'reaproveitando os componentes e padrões já existentes. Ao terminar, MOSTRE o resultado no ' +
            'preview — abra ou atualize a tela do projeto com a nova aparência para o usuário ver rodando.',
          '✅ Aprovei o design — aplique no projeto conforme o que pedi.',
          [],
          [],
          []
        )
        notify('sucesso', 'Design aprovado — adaptando ao projeto e mostrando o resultado no preview.')
      } else {
        void dispatch(
          conv,
          'O usuário descartou o design exibido no preview do Stitch. Não implemente nada; se ele pedir, ajuste o design depois.',
          '🗑️ Descartei o design do Stitch.',
          [],
          [],
          []
        )
        if (stitchTab) void window.api.closeTab(stitchTab.id)
      }
    },
    [dispatch, browserState.tabs, notify]
  )

  // ---- derived view state ----
  const active = conversations.find((c) => c.id === activeId) ?? null
  // The active Stitch design tab, and whether it was already approved (bar hidden).
  const activeStitchTab = browserState.tabs.find((t) => t.active && t.kind === 'stitch')
  const stitchApplied = !!activeStitchTab && appliedStitch.has(activeStitchTab.id)
  const activeConnected = activeId !== null && connectedIds.has(activeId)
  const showBusy = activeId !== null && busyIds.has(activeId)
  const activePermission = activeId ? permissions[activeId] : undefined
  const messages = active?.messages ?? []
  const tokens = active?.tokens ?? EMPTY_TOKENS
  const activeQueue = active ? queue.filter((m) => m.convId === active.id) : []
  const runningSince = activeId ? busySince[activeId] ?? null : null
  const lastDurationMs = activeId ? lastDuration[activeId] ?? null : null

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
      />

      <div className="main-area">
        <header className="topbar">
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
          <button
            className={`btn ghost remote-btn topbar-right ${remoteRunning ? 'on' : ''}`}
            onClick={() => setRemoteOpen(true)}
            title="Controle remoto pelo celular (Android)"
          >
            <IconSmartphone />
            {remoteRunning && <span className="remote-dot" />}
          </button>
          <button
            className="btn ghost settings-btn"
            onClick={() => setSettingsOpen(true)}
            title="Configurações (Google Stitch, etc.)"
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
            draft={active?.draft ?? ''}
            onDraftChange={onDraftChange}
            projectMissing={projectMissing}
            projectMissingMsg={active ? `A pasta do projeto não existe mais: ${active.cwd}` : ''}
            queued={activeQueue}
            onDeleteQueued={deleteQueued}
            runningSince={runningSince}
            lastDurationMs={lastDurationMs}
            onStart={connectStart}
            voiceReady={voiceReady}
            onNeedVoiceKey={needVoiceKey}
            tts={tts}
            models={models}
            model={active?.model ?? MODELS[0].id}
            modelLocked={!active || activeConnected}
            onModelChange={(m) => active && patchConv(active.id, (c) => ({ ...c, model: m }))}
            onModelLockedClick={() =>
              notify('aviso', 'Pare a sessão (botão no topo) para poder trocar o modelo.')
            }
            skipPerms={skipPerms}
            onToggleSkipPerms={toggleSkipPerms}
          />
          {!browserMinimized && (
            <div
              className="splitter"
              onMouseDown={startBrowserDrag}
              title="Arraste para redimensionar o navegador"
            />
          )}
          <BrowserPanel
            state={browserState}
            minimized={browserMinimized}
            onToggleMinimize={() => setBrowserMinimized((v) => !v)}
            width={browserWidth}
            onRequestNewTab={() => setNewTabOpen(true)}
            onStitchDecision={decideStitch}
            stitchApplied={stitchApplied}
          />
        </div>
      </div>

      {activePermission &&
        (activePermission.questions ? (
          <QuestionModal
            request={activePermission}
            onAnswer={answerQuestion}
            onCancel={() => respond('deny', false)}
          />
        ) : (
          <PermissionModal request={activePermission} onRespond={respond} />
        ))}
      {newTabOpen && (
        <NewTabModal
          onPick={(kind) => {
            setNewTabOpen(false)
            void openTab(kind)
          }}
          onClose={() => setNewTabOpen(false)}
        />
      )}
      {remoteOpen && <RemoteModal onClose={() => setRemoteOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={closeSettings} focus={settingsFocus} />}
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
