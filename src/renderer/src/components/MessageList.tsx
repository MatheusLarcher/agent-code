import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent
} from 'react'
import type { UIMessage } from '../types'
import { QuestionMap } from './QuestionMap'
import { isDownloadableFile, isTextPreviewable, parseDownloads } from '@shared/ipc'
import { useUI } from '../ui/UiProvider'
import { fileMeta, fmtSize } from '../files'
import { IconSpeaker, IconStopSmall } from './Icons'
import { CodeBlock, extToLang } from './CodeBlock'
import { Markdown } from './Markdown'

/** Read-aloud controls passed down from App (TTS state lives there so audio
 *  survives message re-renders and conversation switches). */
export interface TtsControls {
  /** Id of the message currently being read (or loading), else null. */
  speakingId: string | null
  /** Start/stop reading a message's answer aloud. */
  onToggleSpeak: (id: string, text: string) => void
}

/** Last path segment, for the chip label. */
function fileLabel(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** A "Baixar" button rendered under an assistant message that flagged a file. */
function DownloadChip({ path }: { path: string }): JSX.Element {
  const { notify } = useUI()
  const download = async (): Promise<void> => {
    const r = await window.api.downloadFile(path)
    notify(r.ok ? 'sucesso' : 'erro', r.message)
  }
  return (
    <button className="msg-download" onClick={download} title={path}>
      ⬇️ Baixar {fileLabel(path)}
    </button>
  )
}

/**
 * Path of a deliverable a `Write` produced (else ''). Only the `Write` tool
 * (file creation, not edits to existing source) and only deliverable extensions
 * (APK, zip, PDF, image…) qualify — so code/config the agent edits never gets a
 * download chip, just the artifacts the user asked to create.
 */
function writtenPath(name: string, input: unknown): string {
  if (name !== 'Write') return ''
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const p = inp.file_path
  return typeof p === 'string' && isDownloadableFile(p) ? p : ''
}

/** "há X" relative label for a time earlier TODAY (else ''). */
function relativeToday(ts: number, now: number): string {
  const d = new Date(ts)
  const n = new Date(now)
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  if (!sameDay) return ''
  const secs = Math.max(0, Math.floor((now - ts) / 1000))
  if (secs < 45) return 'agora mesmo'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `há ${mins} min`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem ? `há ${hrs} h ${rem} min` : `há ${hrs} h`
}

/** Date+time stamp shown under the last assistant answer. If the task ran today,
 *  it also shows how long ago (refreshing every 30s). */
function MessageTime({ ts }: { ts: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const rel = relativeToday(ts, now)
  useEffect(() => {
    if (!rel) return // only a "today" stamp needs to keep ticking
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [rel])

  const d = new Date(ts)
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  const sameDay = !!relativeToday(ts, Date.now())
  const absolute = sameDay
    ? `Hoje às ${time}`
    : `${d.toLocaleDateString('pt-BR')} às ${time}`
  return (
    <div className="msg-time" title={d.toLocaleString('pt-BR')}>
      {absolute}
      {rel && <span className="msg-time-rel"> · {rel}</span>}
    </div>
  )
}

/** How many messages to render at first, and to add each time the user scrolls
 *  to the top. Keeps very long conversations cheap to render (Gemini-style). */
const PAGE = 40

/** Last path segment of a file path (handles both / and \ separators). */
function baseName(p: unknown): string {
  if (typeof p !== 'string' || !p) return ''
  return p.split(/[\\/]/).pop() || p
}

/** Number of lines in a string (0 for empty/non-strings). */
function lineCount(s: unknown): number {
  return typeof s === 'string' && s.length ? s.split('\n').length : 0
}

interface ToolInfo {
  /** Action shown in monospace (e.g. "Skill", "Edit", "Read"). */
  verb: string
  /** Secondary detail: skill name or file name. */
  detail: string
  /** True for the Skill tool — rendered with the accent highlight. */
  isSkill: boolean
  /** Added/removed line counts for file edits, else null. */
  stats: { added: number; removed: number } | null
}

/** Derive a compact, Claude-Code-style label (and edit stats) for a tool call. */
function describeTool(name: string, input: unknown): ToolInfo {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  switch (name) {
    case 'Skill':
      return { verb: 'Skill', detail: String(inp.skill ?? 'skill'), isSkill: true, stats: null }
    case 'Bash': {
      // Show the first line of the command right in the (collapsed) head, so the
      // user can read what ran without expanding.
      const cmd = typeof inp.command === 'string' ? inp.command.trim() : ''
      const firstLine = cmd.split('\n')[0]
      const detail = firstLine.length > 64 ? firstLine.slice(0, 64) + '…' : firstLine
      return { verb: 'Bash', detail, isSkill: false, stats: null }
    }
    case 'Write':
      return { verb: 'Write', detail: baseName(inp.file_path), isSkill: false, stats: { added: lineCount(inp.content), removed: 0 } }
    case 'Edit':
      return {
        verb: 'Edit',
        detail: baseName(inp.file_path),
        isSkill: false,
        stats: { added: lineCount(inp.new_string), removed: lineCount(inp.old_string) }
      }
    case 'MultiEdit': {
      let added = 0
      let removed = 0
      if (Array.isArray(inp.edits)) {
        for (const e of inp.edits as Array<Record<string, unknown>>) {
          added += lineCount(e?.new_string)
          removed += lineCount(e?.old_string)
        }
      }
      return { verb: 'Edit', detail: baseName(inp.file_path), isSkill: false, stats: { added, removed } }
    }
    case 'NotebookEdit':
      return { verb: 'Edit', detail: baseName(inp.notebook_path), isSkill: false, stats: { added: lineCount(inp.new_source), removed: 0 } }
    case 'Read':
      return { verb: 'Read', detail: baseName(inp.file_path), isSkill: false, stats: null }
    case 'AskUserQuestion': {
      const qs = Array.isArray(inp.questions) ? (inp.questions as Array<Record<string, unknown>>) : []
      const first = qs[0]
      return { verb: 'Pergunta', detail: typeof first?.header === 'string' ? first.header : '', isSkill: false, stats: null }
    }
    default:
      return { verb: name.replace(/^mcp__browser__/, '🌐 ').replace(/^mcp__[^_]+__/, ''), detail: '', isSkill: false, stats: null }
  }
}

/** A human-readable view of a tool's input: a real code block (with newlines
 *  and quotes intact — no escaped \n / \" noise) instead of raw escaped JSON. */
interface InputView {
  /** Optional small caption above the block (e.g. a Bash command's description). */
  caption: string
  language: string
  code: string
}

function toolInputView(name: string, input: unknown): InputView {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Bash':
      return { caption: str(inp.description), language: 'bash', code: str(inp.command) }
    case 'Write':
      return { caption: str(inp.file_path), language: extToLang(str(inp.file_path)), code: str(inp.content) }
    case 'Edit':
    case 'NotebookEdit': {
      const oldS = str(inp.old_string || inp.old_source)
      const newS = str(inp.new_string || inp.new_source)
      const diffLines = [
        ...oldS.split('\n').map((l) => '- ' + l),
        ...newS.split('\n').map((l) => '+ ' + l)
      ].join('\n')
      return { caption: str(inp.file_path || inp.notebook_path), language: 'diff', code: diffLines }
    }
    case 'MultiEdit': {
      const edits = Array.isArray(inp.edits) ? (inp.edits as Array<Record<string, unknown>>) : []
      const code = edits
        .map((e) =>
          [
            ...str(e?.old_string).split('\n').map((l) => '- ' + l),
            ...str(e?.new_string).split('\n').map((l) => '+ ' + l)
          ].join('\n')
        )
        .join('\n\n')
      return { caption: str(inp.file_path), language: 'diff', code }
    }
    default:
      // Anything else: pretty JSON, highlighted as JSON (still far more readable
      // than a one-line escaped blob).
      return { caption: '', language: 'json', code: JSON.stringify(input, null, 2) }
  }
}

function ToolCard({ m }: { m: Extract<UIMessage, { kind: 'tool-use' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const { notify } = useUI()
  const info = describeTool(m.name, m.input)
  const hasDiff = info.stats && (info.stats.added > 0 || info.stats.removed > 0)
  // AskUserQuestion has no allow/deny: its answer is fed back as a `deny` message,
  // so its tool-result is flagged is_error — but that's NOT a failure. Treat it as
  // a normal "answered" outcome (don't paint it red).
  const isQuestion = m.name === 'AskUserQuestion'
  const noAnswer = isQuestion && !!m.result && /não respondeu|tempo|esgotado/i.test(m.result.text)
  const errored = !!m.result?.isError && !isQuestion
  // Offer a download once the write succeeded (the file exists on disk).
  const filePath = m.result && !m.result.isError ? writtenPath(m.name, m.input) : ''
  
  let rawFilePath = ''
  if (m.name === 'Write' && m.input && typeof m.input === 'object') {
    const p = (m.input as Record<string, unknown>).file_path
    if (typeof p === 'string' && p) rawFilePath = p
  }

  const download = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    const r = await window.api.downloadFile(filePath)
    notify(r.ok ? 'sucesso' : 'erro', r.message)
  }

  const preview = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!rawFilePath) return
    const fileUrl = 'file:///' + rawFilePath.replace(/\\/g, '/').replace(/^\//, '')
    try {
      const res = await window.api.newTab('file', fileUrl)
      if (res && res !== 'sucesso' && !res.toLowerCase().includes('abrindo') && !res.toLowerCase().includes('aberta')) {
        notify('erro', res)
      }
    } catch (err) {
      notify('erro', `Falha ao abrir preview: ${String(err)}`)
    }
  }

  return (
    <div className={`tool-card ${info.isSkill ? 'tool-skill' : ''} ${errored ? 'tool-error' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{info.verb}</span>
        {info.detail && <span className="tool-detail">{info.detail}</span>}
        {hasDiff && info.stats && (
          <span className="tool-diff">
            {info.stats.added > 0 && <span className="diff-add">+{info.stats.added}</span>}
            {info.stats.removed > 0 && <span className="diff-del">−{info.stats.removed}</span>}
          </span>
        )}
        {rawFilePath && isTextPreviewable(rawFilePath) && m.result && !m.result.isError && (
          <span className="tool-download" onClick={preview} title="Abrir em uma Janela de Arquivo">
            Preview
          </span>
        )}
        {filePath && (
          <span className="tool-download" onClick={download} title="Baixar arquivo">
            ⬇️ Baixar
          </span>
        )}
        {m.result ? (
          isQuestion ? (
            <span className="tool-badge ok">{noAnswer ? 'sem resposta' : 'respondido'}</span>
          ) : (
            <span className={`tool-badge ${m.result.isError ? 'err' : 'ok'}`}>{m.result.isError ? 'error' : 'done'}</span>
          )
        ) : (
          <span className="tool-badge run">running…</span>
        )}
      </button>
      {open && (() => {
        const view = toolInputView(m.name, m.input)
        return (
          <div className="tool-body">
            {view.caption && <div className="tool-caption">{view.caption}</div>}
            {view.code ? (
              <CodeBlock code={view.code.slice(0, 6000)} language={view.language} />
            ) : (
              <div className="tool-empty">(sem conteúdo)</div>
            )}
            {m.result && (
              <>
                <div className="tool-section-label">resultado</div>
                <pre className="tool-result-pre">{m.result.text.slice(0, 2500)}</pre>
              </>
            )}
          </div>
        )
      })()}
    </div>
  )
}

export function MessageList({
  messages,
  busy,
  tts,
  onRetry,
  scrollToId,
  scrollSeq
}: {
  messages: UIMessage[]
  busy: boolean
  tts: TtsControls
  /** Resend a user message whose turn failed. */
  onRetry: (msgId: string) => void
  /** Id of a message to scroll to (from a search hit), or null. */
  scrollToId?: string | null
  /** Bumped on each search-hit navigation so repeats re-trigger the scroll. */
  scrollSeq?: number
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(PAGE)
  const [knownTotal, setKnownTotal] = useState(messages.length)
  // Whether the "jump to bottom" button is shown (user scrolled up from the end).
  const [showJump, setShowJump] = useState(false)
  const [scrollRatio, setScrollRatio] = useState(1)
  // Id of the user message nearest the viewport center — drives the QuestionMap's
  // active dot from real element positions instead of an index-vs-scrollTop guess
  // (message heights vary and pagination skews any ratio-based mapping).
  const [activeMid, setActiveMid] = useState<string | null>(null)
  const [mapScroll, setMapScroll] = useState<{ id: string; seq: number } | null>(null)
  // Last handled search-scroll request, so the same nav doesn't re-fire forever.
  const lastSeq = useRef(-1)
  const effectiveTarget = mapScroll?.id ?? scrollToId
  const effectiveSeq = mapScroll?.seq ?? scrollSeq
  const pendingScroll = effectiveTarget != null && effectiveSeq !== lastSeq.current

  // Refs coordinating the two scroll behaviors below.
  const atBottom = useRef(true) // was the user pinned to the bottom?
  const loadingOlder = useRef(false) // are we prepending older messages right now?
  const loadAnchor = useRef<{ node: HTMLElement; top: number } | null>(null)
  const first = useRef(true)

  // Only the last `visible` messages are actually rendered.
  const total = messages.length
  // While the user is reading history, keep the current window start fixed when
  // live events append at the end. Adjusting state during render makes React
  // restart this render before committing, so the first visible row is never
  // briefly removed from the DOM.
  if (total !== knownTotal) {
    const added = total - knownTotal
    setKnownTotal(total)
    if (added > 0 && !atBottom.current) setVisible((v) => v + added)
  }
  const startIdx = Math.max(0, total - visible)
  const shown = messages.slice(startIdx)
  const hasOlder = startIdx > 0

  // Id of the most recent assistant answer that carries a finish time — only that
  // one shows the date/time (and, if today, the "how long ago") footer.
  let lastTsId: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'assistant-text' && m.ts) {
      lastTsId = m.id
      break
    }
  }

  // After older messages are prepended, keep the exact same DOM row at the same
  // screen position. A global scrollHeight delta is incorrect when streaming or
  // the typing/banner state changes below/around the viewport in the same commit.
  useLayoutEffect(() => {
    if (!loadingOlder.current) return
    const el = scrollRef.current
    const anchor = loadAnchor.current
    if (el && anchor?.node.isConnected) {
      el.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top
    }
    loadAnchor.current = null
    loadingOlder.current = false
  }, [visible])

  // New/updated messages: jump to bottom on first paint, then only when the
  // user is already near the bottom (so reading history isn't interrupted).
  useEffect(() => {
    if (loadingOlder.current) return
    if (first.current) {
      // Arriving from a search hit: don't yank to the bottom — let the scroll
      // effect below center the matched prompt instead.
      if (!pendingScroll) endRef.current?.scrollIntoView()
      first.current = false
      return
    }
    if (atBottom.current) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Search-hit navigation: make sure the target is inside the rendered window,
  // then scroll it to the center and flash it once.
  useEffect(() => {
    if (!pendingScroll || !effectiveTarget) return
    const idx = messages.findIndex((m) => m.kind === 'user' && m.id === effectiveTarget)
    if (idx < 0) return
    const needed = total - idx + 4 // a few messages of context below it
    setVisible((v) => (v < needed ? needed : v))
  }, [pendingScroll, effectiveTarget, effectiveSeq, messages, total])

  useLayoutEffect(() => {
    if (!pendingScroll || !effectiveTarget) return
    const root = scrollRef.current
    const el = root?.querySelector(`[data-mid="${CSS.escape(effectiveTarget)}"]`) as HTMLElement | null
    if (!el) return // not in the window yet — the effect above expands it, re-running this
    el.scrollIntoView({ block: 'center' })
    el.classList.add('msg-flash')
    window.setTimeout(() => el.classList.remove('msg-flash'), 2200)
    lastSeq.current = effectiveSeq ?? -1
    if (mapScroll?.id === effectiveTarget) setMapScroll(null)
  }, [pendingScroll, effectiveTarget, effectiveSeq, visible, messages, mapScroll])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottom.current = fromBottom < 120
    const far = fromBottom > 240
    setShowJump((v) => (v === far ? v : far))
    const max = Math.max(1, el.scrollHeight - el.clientHeight)
    setScrollRatio(Math.max(0, Math.min(1, el.scrollTop / max)))
    // Which user message ([data-mid] is user-only) is nearest the viewport
    // center right now — the QuestionMap highlights that one. Only rendered
    // (non-paginated-out) prompts count, which is exactly what's on screen.
    const viewportCenter = el.scrollTop + el.clientHeight / 2
    const nodes = el.querySelectorAll<HTMLElement>('[data-mid]')
    let lo = 0
    let hi = nodes.length - 1
    let bestId: string | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    // Rows are ordered vertically, so binary search needs only O(log N) layout
    // reads even after the user has revealed thousands of old messages.
    while (lo <= hi) {
      const probe = Math.floor((lo + hi) / 2)
      const node = nodes[probe]
      const center = node.offsetTop + node.offsetHeight / 2
      const distance = Math.abs(center - viewportCenter)
      if (distance < bestDistance) {
        bestDistance = distance
        bestId = node.dataset.mid || null
      }
      if (center < viewportCenter) lo = probe + 1
      else hi = probe - 1
    }
    setActiveMid((v) => (v === bestId ? v : bestId))
    // Near the top with more to show → load another page, keeping position.
    if (el.scrollTop < 80 && hasOlder && !loadingOlder.current) {
      const anchor = Array.from(el.children).find(
        (node): node is HTMLElement => node instanceof HTMLElement && node.matches('.msg, .tool-card')
      )
      loadAnchor.current = anchor ? { node: anchor, top: anchor.getBoundingClientRect().top } : null
      loadingOlder.current = true
      setVisible((v) => v + PAGE)
    }
  }

  const jumpToBottom = (): void => {
    atBottom.current = true
    setShowJump(false)
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="message-list-wrap">
    <QuestionMap messages={messages} scrollRatio={scrollRatio} activeId={activeMid} onSelect={(id) => setMapScroll({ id, seq: Date.now() })} />
    <div className="message-list" ref={scrollRef} onScroll={onScroll}>
      {hasOlder && (
        <div className="load-more-hint">↑ Role para cima para carregar mais ({startIdx} anteriores)</div>
      )}
      {shown.map((m, i) => {
        const idx = startIdx + i
        switch (m.kind) {
          case 'user':
            return (
              <div key={`user:${m.id}`} className="msg user" data-mid={m.id}>
                <div className={`bubble ${m.error ? 'has-error' : ''}`}>
                  {m.images && m.images.length > 0 && (
                    <div className="msg-images">
                      {m.images.map((src, k) => (
                        <img key={k} className="msg-image" src={src} alt="anexo" />
                      ))}
                    </div>
                  )}
                  {m.files && m.files.length > 0 && (
                    <div className="msg-files">
                      {m.files.map((f, k) => {
                        const meta = fileMeta(f.name)
                        return (
                          <span className="file-card" key={k} title={f.name}>
                            <span className={`file-badge kind-${meta.kind}`}>{meta.ext}</span>
                            <span className="file-card-info">
                              <span className="file-card-name">{f.name}</span>
                              {f.size > 0 && <span className="file-card-size">{fmtSize(f.size)}</span>}
                            </span>
                          </span>
                        )
                      })}
                    </div>
                  )}
                  {m.text}
                </div>
                {m.canceled && <div className="msg-canceled">⊘ Mensagem cancelada</div>}
                {m.error && (
                  <div className="msg-error">
                    <span className="msg-error-text" title={m.error}>
                      ⚠ Não foi enviada — {m.error}
                    </span>
                    <button
                      className="msg-retry"
                      onClick={() => onRetry(m.id)}
                      disabled={busy}
                      title={busy ? 'Aguarde a tarefa atual terminar' : 'Reenviar esta mensagem'}
                    >
                      ↻ Tentar de novo
                    </button>
                  </div>
                )}
                {m.ts && <MessageTime ts={m.ts} />}
              </div>
            )
          case 'assistant-text': {
            const { clean, paths } = parseDownloads(m.text)
            const speaking = tts.speakingId === m.id
            return (
              <div
                key={`assistant:${m.id}`}
                className={`msg assistant ${m.answer ? '' : 'narration'} ${m.aborted ? 'aborted' : ''}`}
              >
                <div className="bubble">
                  {clean && <Markdown text={clean} />}
                  {paths.map((p, k) => (
                    <DownloadChip key={k} path={p} />
                  ))}
                  {((m.answer && clean) || (m.id === lastTsId && m.ts)) && (
                    <div className="msg-foot">
                      {m.answer && clean && (
                        <button
                          className={`msg-speak ${speaking ? 'active' : ''}`}
                          onClick={() => tts.onToggleSpeak(m.id, clean)}
                          title={speaking ? 'Parar leitura' : 'Ler em voz alta'}
                        >
                          {speaking ? <IconStopSmall size={14} /> : <IconSpeaker size={15} />}
                          {speaking ? 'Parar' : 'Ouvir'}
                        </button>
                      )}
                      {m.id === lastTsId && m.ts && <MessageTime ts={m.ts} />}
                    </div>
                  )}
                  {m.aborted && (
                    <div className="msg-aborted">Resposta interrompida pelo Stop — pode estar incompleta.</div>
                  )}
                </div>
              </div>
            )
          }
          case 'thinking':
            return (
              <div key={`thinking:${m.id}`} className="msg thinking">
                <div className="bubble">{m.text}</div>
              </div>
            )
          case 'tool-use':
            return <ToolCard key={`tool:${m.id}`} m={m} />
          case 'system':
            return (
              <div key={`system:${m.sessionId}:${idx}`} className="msg system-note">
                Session ready · {m.model} · {m.cwd}
              </div>
            )
          case 'result':
            // Not rendered: the answer is already in the chat and the cost is
            // shown in the token meter header.
            return null
          case 'error':
            return (
              <div key={`error:${m.id}`} className="msg result-note err">
                {m.text}
              </div>
            )
          default:
            return null
        }
      })}
      {busy && (
        <div className="msg assistant">
          <div className="bubble typing">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      )}
      <div ref={endRef} />
    </div>
      {showJump && (
        <button className="jump-bottom" title="Ir para o final" onClick={jumpToBottom}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="6 13 12 19 18 13" />
          </svg>
        </button>
      )}
    </div>
  )
}
