import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { UIMessage } from '../types'
import { isDownloadableFile } from '@shared/ipc'
import { useUI } from '../ui/UiProvider'

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

// Links must open in the system browser, not navigate the app frame. Forcing
// target=_blank routes the click through the main process' window-open handler
// (shell.openExternal), so the Electron renderer never navigates away.
const mdComponents = {
  a: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />
}

/** Render assistant text as GitHub-flavored Markdown (headings, lists, code,
 *  tables, etc.). Safe: react-markdown builds React nodes, no raw HTML. */
function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
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
    default:
      return { verb: name.replace(/^mcp__browser__/, '🌐 ').replace(/^mcp__[^_]+__/, ''), detail: '', isSkill: false, stats: null }
  }
}

function ToolCard({ m }: { m: Extract<UIMessage, { kind: 'tool-use' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const { notify } = useUI()
  const info = describeTool(m.name, m.input)
  const hasDiff = info.stats && (info.stats.added > 0 || info.stats.removed > 0)
  // Offer a download once the write succeeded (the file exists on disk).
  const filePath = m.result && !m.result.isError ? writtenPath(m.name, m.input) : ''

  const download = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    const r = await window.api.downloadFile(filePath)
    notify(r.ok ? 'sucesso' : 'erro', r.message)
  }

  return (
    <div className={`tool-card ${info.isSkill ? 'tool-skill' : ''} ${m.result?.isError ? 'tool-error' : ''}`}>
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
        {filePath && (
          <span className="tool-download" onClick={download} title="Baixar arquivo">
            ⬇️ Baixar
          </span>
        )}
        {m.result ? (
          <span className={`tool-badge ${m.result.isError ? 'err' : 'ok'}`}>{m.result.isError ? 'error' : 'done'}</span>
        ) : (
          <span className="tool-badge run">running…</span>
        )}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section-label">input</div>
          <pre>{JSON.stringify(m.input, null, 2).slice(0, 1500)}</pre>
          {m.result && (
            <>
              <div className="tool-section-label">result</div>
              <pre>{m.result.text.slice(0, 2500)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function MessageList({ messages, busy }: { messages: UIMessage[]; busy: boolean }): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(PAGE)

  // Refs coordinating the two scroll behaviors below.
  const atBottom = useRef(true) // was the user pinned to the bottom?
  const loadingOlder = useRef(false) // are we prepending older messages right now?
  const prevHeight = useRef(0)
  const prevTop = useRef(0)
  const first = useRef(true)

  // Only the last `visible` messages are actually rendered.
  const total = messages.length
  const startIdx = Math.max(0, total - visible)
  const shown = messages.slice(startIdx)
  const hasOlder = startIdx > 0

  // After older messages are prepended, anchor the viewport so it doesn't jump
  // (the newly added content pushes everything down by its height).
  useLayoutEffect(() => {
    if (!loadingOlder.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight - prevHeight.current + prevTop.current
    loadingOlder.current = false
  }, [visible])

  // New/updated messages: jump to bottom on first paint, then only when the
  // user is already near the bottom (so reading history isn't interrupted).
  useEffect(() => {
    if (loadingOlder.current) return
    if (first.current) {
      endRef.current?.scrollIntoView()
      first.current = false
      return
    }
    if (atBottom.current) endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    // Near the top with more to show → load another page, keeping position.
    if (el.scrollTop < 80 && hasOlder && !loadingOlder.current) {
      prevHeight.current = el.scrollHeight
      prevTop.current = el.scrollTop
      loadingOlder.current = true
      setVisible((v) => v + PAGE)
    }
  }

  return (
    <div className="message-list" ref={scrollRef} onScroll={onScroll}>
      {hasOlder && (
        <div className="load-more-hint">↑ Role para cima para carregar mais ({startIdx} anteriores)</div>
      )}
      {shown.map((m, i) => {
        const idx = startIdx + i
        switch (m.kind) {
          case 'user':
            return (
              <div key={m.id} className="msg user">
                <div className="bubble">
                  {m.images && m.images.length > 0 && (
                    <div className="msg-images">
                      {m.images.map((src, k) => (
                        <img key={k} className="msg-image" src={src} alt="anexo" />
                      ))}
                    </div>
                  )}
                  {m.text}
                </div>
              </div>
            )
          case 'assistant-text':
            return (
              <div key={m.id} className={`msg assistant ${m.answer ? '' : 'narration'}`}>
                <div className="bubble">
                  <Markdown text={m.text} />
                </div>
              </div>
            )
          case 'thinking':
            return (
              <div key={m.id + idx} className="msg thinking">
                <div className="bubble">{m.text}</div>
              </div>
            )
          case 'tool-use':
            return <ToolCard key={m.id} m={m} />
          case 'system':
            return (
              <div key={'sys' + idx} className="msg system-note">
                Session ready · {m.model} · {m.cwd}
              </div>
            )
          case 'result':
            // Not rendered: the answer is already in the chat and the cost is
            // shown in the token meter header.
            return null
          case 'error':
            return (
              <div key={m.id} className="msg result-note err">
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
  )
}
