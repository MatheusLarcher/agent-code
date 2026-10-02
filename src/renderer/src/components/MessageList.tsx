import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from '../types'
import { QuestionMap } from './QuestionMap'
import { AccountSwitchNote } from './AccountSwitchNote'
import { parseDownloads } from '@shared/ipc'
import { useUI } from '../ui/UiProvider'
import { fileMeta, fmtSize } from '../files'
import { IconSpeaker, IconStopSmall } from './Icons'
import { ToolCard } from './ToolCard'
import { CardRefText, Markdown } from './Markdown'
import { InlineMediaText } from '../inlineMedia/InlineMediaText'
import { useKeepEndOnResize } from './MessageListAnchor'
import { useChatDisplay } from './chatDisplay'
import { makeRefResolver } from '../planning/cardRefs'
import { PlanFileLink, createdPlanFile } from '../planning/PlanFileLink'
import { QuotableMessage, type QuoteListApi } from './quoteComment/quoteBlocks'

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
                  {!m.media && m.images && m.images.length > 0 && (
                    <div className="msg-images">
                      {m.images.map((src, k) => (
                        <img key={k} className="msg-image" src={src} alt="anexo" />
                      ))}
                    </div>
                  )}
                  {!m.media && m.files && m.files.length > 0 && (
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
                  {m.media ? (
                    // Anexos postos no meio do texto: cada {{midia:N}} vira o item no lugar.
                    <InlineMediaText
                      text={m.text}
                      media={m.media}
                      images={m.images}
                      files={m.files}
                      renderText={(t) => (resolveRef ? <CardRefText text={t} resolveRef={resolveRef} /> : t)}
                    />
                  ) : resolveRef ? (
                    <CardRefText text={m.text} resolveRef={resolveRef} />
                  ) : (
                    m.text
                  )}
                </div>
                {m.canceled && <div className="msg-canceled">⊘ Mensagem cancelada</div>}
                {m.injected && <div className="msg-injected">↳ ajuste enviado durante a tarefa</div>}
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
                  {clean && (
                    <QuotableMessage api={quote} messageId={m.id} read={m.answer ? tts : null} source={clean}>
                      <Markdown text={clean} resolveRef={resolveRef} />
                    </QuotableMessage>
                  )}
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
          case 'tool-use': {
            // Planejamento: arquivo que o agente criou no plano ganha link logo abaixo.
            const created = createdPlanFile(m.name, m.input, m.result, planDir)
            if (!created) return <ToolCard key={`tool:${m.id}`} m={m} />
            return (
              <Fragment key={`tool:${m.id}`}>
                <ToolCard m={m} />
                <PlanFileLink path={created} />
              </Fragment>
            )
          }
          case 'system':
            return (
              <div key={`system:${m.sessionId}:${idx}`} className="msg system-note">
                Session ready · {m.model} · {m.cwd}
              </div>
            )
          case 'provider-switch':
            return <div key={`provider-switch:${m.id}`} className="msg system-note" role="status">{m.text}</div>
          case 'account-switch':
            return <AccountSwitchNote key={`account-switch:${m.id}`} event={m} onUseAccount={onUseAccount} />
          case 'status':
            return <div key={`status:${m.id}`} className="msg system-note" role="status">{m.text}</div>
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
