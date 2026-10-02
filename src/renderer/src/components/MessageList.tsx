import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from '../types'
import { QuestionMap } from './QuestionMap'
import { useKeepEndOnResize } from './MessageListAnchor'
import { useChatDisplay } from './chatDisplay'
import { makeRefResolver } from '../planning/cardRefs'
import type { QuoteListApi } from './quoteComment/quoteBlocks'
import { ChatRow, lastAnswerTsId, rowKey, type ChatRowContext, type TtsControls } from './ChatRows'

export type { TtsControls } from './ChatRows'

/** How many messages to render at first, and to add each time the user scrolls
 *  to the top. Keeps very long conversations cheap to render (Gemini-style). */
const PAGE = 40

export function MessageList({
  messages,
  busy,
  tts,
  onRetry,
  onUseAccount,
  scrollToId,
  scrollSeq,
  quote
}: {
  messages: UIMessage[]
  busy: boolean
  tts: TtsControls
  /** Resend a user message whose turn failed. */
  onRetry: (msgId: string) => void
  /** Troca manual de conta (botão "Continuar nessa conta" da nota de sugestão). */
  onUseAccount?: (accountId: string, continueTask: boolean) => void
  /** Id of a message to scroll to (from a search hit), or null. */
  scrollToId?: string | null
  /** Bumped on each search-hit navigation so repeats re-trigger the scroll. */
  scrollSeq?: number
  /** "Comentar" nos blocos das respostas do agente (ver quoteComment/). Sem ele, nada muda. */
  quote?: QuoteListApi
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
  // Chat do Agent Manager (cards no contexto): [[Nome]] de um card sai com a cor
  // do tipo dele. Sem cards (qualquer outra conversa), o texto fica como sempre.
  const { cardRefs, planDir } = useChatDisplay()
  const resolveRef = useMemo(() => (cardRefs?.length ? makeRefResolver(cardRefs) : null), [cardRefs])

  // Refs coordinating the two scroll behaviors below.
  const atBottom = useRef(true) // was the user pinned to the bottom?
  const loadingOlder = useRef(false) // are we prepending older messages right now?
  const loadAnchor = useRef<{ node: HTMLElement; top: number } | null>(null)
  const first = useRef(true)

  // The footer (composer, "Última resposta"…) grew or shrank → the list box
  // changed size: stay pinned to the end if the user was there ("there" = the
  // same 120px margin that decides whether new messages are followed). Not
  // while prepending older pages or centering a search hit — those own the scroll.
  useKeepEndOnResize(
    scrollRef,
    () => atBottom.current && !loadingOlder.current && !(effectiveTarget != null && effectiveSeq !== lastSeq.current)
  )

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

  // Only the most recent answer with a finish time shows the date/time footer.
  const rowCtx: ChatRowContext = { resolveRef, planDir, lastTsId: lastAnswerTsId(messages), busy, onRetry, tts, quote, onUseAccount }

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
      {shown.map((m, i) => (
        <ChatRow key={rowKey(m, startIdx + i)} m={m} ctx={rowCtx} />
      ))}
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
