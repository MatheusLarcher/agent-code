/**
 * As entradas da Central no celular (o retrato do PC, desenhado sem refazer nada):
 * pedido com o aviso do destino e o "Para onde vai?", bloco de resposta com a
 * linha de atividade (o toque abre as ações do turno, lidas do destino) e as
 * perguntas/permissões dos destinos. Pedido de OUTRO PC (`foreign`): só aquele PC
 * entrega — as opções aparecem sem botão e nada é enviado daqui.
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react'
import type { RemoteCentralAnswered, RemoteCentralOption, RemoteCentralReply, RemoteCentralRequest } from '@shared/central'
import { Markdown } from '@renderer/components/Markdown'
import { client, openConversation, toast } from '../app/runtime'
import { triggerDownload } from '../core/download'
import { basename, parseDownloads } from '../core/format'
import { useStore } from '../core/store'
import type { ToolUseMsg } from '../core/types'
import { ToolCard } from '../chat/ToolCard'
import { Icon } from '../ui/icons'
import { centralChoose, centralQuoteOf, loadTurnTools, tint, toggleTurnTools } from './centralActions'
import { centralUi, type CentralQuote, type SentBubble } from './centralStore'
import { useSwipeReply } from './useSwipeReply'

const ASK_HINT: Record<string, string> = {
  'low-confidence': 'não tenho certeza — a mensagem está esperando',
  'typesafe-failed': 'o TypeSafe não respondeu — a mensagem está esperando',
  'target-missing': 'o destino não existe mais — escolha outro',
  moved: 'escolha o destino certo'
}

export const colorVar = (color: unknown): CSSProperties => ({ ['--c' as string]: tint(color) })

/** "abrir": a conversa do destino no app, rolada até o turno quando há âncora. */
export function openDestination(anchor: { convId: string; msgId?: string } | undefined): void {
  if (!anchor?.convId) return
  if (!client.state.conversations.some((c) => c.id === anchor.convId)) {
    toast('Essa conversa não está carregada no PC agora.')
    return
  }
  openConversation(anchor.convId, anchor.msgId || null)
}

export function WaitLine({ text }: { text: string }): JSX.Element {
  return (
    <div className="c-wait">
      <span className="spinner c-spinner" />
      <span>{text}</span>
    </div>
  )
}

/** O ícone do projeto (data URL pequeno que o PC manda) ou o traço: pasta, sandbox ou "+". */
export function DestIcon({ icon, glyph, size }: { icon: string | null | undefined; glyph: string; size: number }): JSX.Element {
  if (typeof icon === 'string' && /^data:image\//i.test(icon)) return <img className="c-pi" alt="" width={size} height={size} src={icon} />
  const name = glyph === 'sandbox' ? 'sandbox' : glyph === 'new' ? 'plus' : 'folder'
  return <Icon name={name} size={size} className="c-pi c-glyph" />
}

export function QuoteBox({ q }: { q: { who: string; color?: string; text: string } }): JSX.Element {
  return (
    <div className="c-quote" style={colorVar(q.color)}>
      <div className="c-quote-body">
        {q.who && <span className="c-quote-who">{q.who}</span>}
        <span className="c-quote-text">{q.text}</span>
      </div>
    </div>
  )
}

/** Envolve a entrada com o gesto de responder (quando ela aceita resposta). */
function Swipeable({ quote, className, style, children }: { quote: CentralQuote | null; className: string; style?: CSSProperties; children: ReactNode }): JSX.Element {
  const swipe = useSwipeReply(quote)
  if (!swipe) return <div className={className} style={style}>{children}</div>
  return (
    <div className={`${className} ${swipe.className}`} style={{ ...style, ...swipe.style }} {...swipe.handlers}>
      {children}
      <span className={`c-swipe-ic${swipe.armed ? ' armed' : ''}`} style={{ opacity: swipe.iconOpacity }}>
        <Icon name="reply" size={16} />
      </span>
    </div>
  )
}

/** O texto com o nome de cada anexo no lugar do {{midia:N}} (como no PC); os sem marcador vão depois. */
function RequestText({ text, names }: { text: string; names: string[] }): JSX.Element {
  const parts: ReactNode[] = []
  const used = new Set<number>()
  const re = /\{\{midia:(\d{1,4})\}\}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    used.add(+m[1])
    parts.push(<span key={`m${m.index}`} className="c-att">{names[+m[1] - 1] || `mídia ${m[1]}`}</span>)
    last = re.lastIndex
  }
  if (last < text.length) parts.push(text.slice(last))
  const rest = names.filter((_, i) => !used.has(i + 1))
  return (
    <>
      {parts}
      {rest.length > 0 && (
        <div className="c-atts">
          {rest.map((n, i) => <span key={i} className="c-att">{n}</span>)}
        </div>
      )}
    </>
  )
}

export function CentralRequest({ e }: { e: RemoteCentralRequest }): JSX.Element {
  const why = useStore(centralUi, (s) => !!s.why[e.id])
  const n = e.notice
  let line: ReactNode = null
  if (e.state === 'routing') line = <WaitLine text="escolhendo o destino…" />
  else if (e.state === 'failed') line = <div className="c-route c-bad">não foi entregue</div>
  else if (n && e.state !== 'asking') {
    line = (
      <div className="c-route" style={colorVar(n.color)}>
        {n.why && why && <span className="c-why">{n.why} ·</span>}
        <button type="button" className="c-to" onClick={() => openDestination(e.anchor)}>
          {(e.origin === 'conversation' ? 'em ' : '→ ') + n.to}
        </button>
      </div>
    )
  }
  return (
    <>
      <Swipeable quote={centralQuoteOf(e)} className="c-me">
        {e.replyTo && <QuoteBox q={e.replyTo} />}
        {/* O porquê do destino fica escondido (no PC aparece no hover): o toque na bolha mostra. */}
        <div
          className="c-bubble"
          onClick={() => n?.why && centralUi.set((s) => ({ why: { ...s.why, [e.id]: !s.why[e.id] } }))}
        >
          <RequestText text={typeof e.text === 'string' ? e.text : ''} names={Array.isArray(e.attachments) ? e.attachments : []} />
        </div>
        {line}
      </Swipeable>
      {/* Adotado (A1) nunca pergunta para onde vai. */}
      {e.state === 'asking' && e.ask && e.origin !== 'conversation' && <CentralAsk e={e} />}
    </>
  )
}

function CentralAsk({ e }: { e: RemoteCentralRequest }): JSX.Element {
  const foreign = e.foreign === true
  const busy = useStore(centralUi, (s) => !foreign && !!s.busy[e.id])
  const options: RemoteCentralOption[] = Array.isArray(e.ask?.options) ? e.ask!.options : []
  return (
    <div className={`c-ask${foreign ? ' foreign' : ''}`}>
      <div className="c-ask-head">
        <span className="c-ask-title">Para onde vai?</span>
        {!foreign && e.ask && ASK_HINT[e.ask.reason] && <span className="c-ask-hint">{ASK_HINT[e.ask.reason]}</span>}
      </div>
      <div className="c-opts">
        {options.map((o, i) => {
          const content = (
            <>
              <DestIcon icon={o.icon} glyph={o.glyph} size={14} />
              <span className="c-opt-label">{o.label || 'destino'}</span>
              {o.sub && <span className="c-opt-sub">{o.sub}</span>}
            </>
          )
          const cls = `c-opt${o.best ? ' best' : ''}`
          return foreign ? (
            <span key={i} className={cls}>{content}</span>
          ) : (
            <button key={i} type="button" className={cls} disabled={busy} onClick={() => centralChoose(e.id, i)}>
              {content}
            </button>
          )
        })}
      </div>
      {foreign ? <div className="c-ask-foreign">aguardando o outro PC</div> : busy ? <WaitLine text="levando para o destino…" /> : null}
    </div>
  )
}

export function CentralSending({ s }: { s: SentBubble }): JSX.Element {
  return (
    <div className="c-me c-sending">
      <div className="c-bubble">{s.text || (s.files === 1 ? '1 anexo' : `${s.files} anexos`)}</div>
      <WaitLine text="enviando…" />
    </div>
  )
}

function Segments({ r }: { r: RemoteCentralReply }): JSX.Element {
  const a = r.activity
  const running = !a?.done
  const nodes: ReactNode[] = (Array.isArray(a?.segments) ? a.segments : []).map((s, i) => {
    if (s?.tone === 'strong') return <b key={i}>{s.text}</b>
    const tone = s?.tone
    const cls = tone === 'add' || tone === 'ok' ? 'c-ok' : tone === 'rem' || tone === 'bad' ? 'c-bad' : ''
    return <span key={i} className={cls}>{s?.text}</span>
  })
  if (running && a?.now) nodes.push(<span key="now">{(nodes.length ? ' · ' : '') + 'agora: ' + a.now}</span>)
  const count = a?.count || 0
  return <span className="c-sum">{nodes.length ? nodes : running ? 'trabalhando…' : `${count} ${count === 1 ? 'ação' : 'ações'}`}</span>
}

function TurnTools({ r }: { r: RemoteCentralReply }): JSX.Element {
  const t = useStore(centralUi, (s) => s.tools[r.id])
  const count = r.activity?.count || 0
  // Turno rodando com ação nova desde a leitura: lê de novo (a lista anterior fica na tela).
  const stale = !!t && !t.loading && !t.error && t.count !== count
  useEffect(() => {
    if (stale) loadTurnTools(r)
  }, [stale, r])
  let body: ReactNode
  if (!t || (t.loading && !t.found)) body = <WaitLine text="carregando as ações…" />
  else if (t.error) body = <div className="c-tools-note c-bad">Não foi possível carregar as ações: {t.error}</div>
  else if (!t.found) body = <div className="c-tools-note">As ações deste turno não estão mais nas mensagens recentes — abra a conversa.</div>
  else {
    body = (
      <>
        {!t.list?.length && <div className="c-tools-note">Nenhuma ação neste trecho.</div>}
        {(t.list ?? []).map((m, i) => <ToolCard key={m.id ?? i} m={m as ToolUseMsg} />)}
        {t.partial && !t.closed && <div className="c-tools-note">Mostrando o trecho disponível — abra a conversa para ver o resto.</div>}
      </>
    )
  }
  return <div className="c-tools">{body}</div>
}

export function CentralReply({ r }: { r: RemoteCentralReply }): JSX.Element | null {
  const open = useStore(centralUi, (s) => !!s.open[r.id])
  if (!r.anchor) return null
  const a = r.activity
  const count = a?.count || 0
  const running = !a?.done
  const parsed = r.answer ? parseDownloads(r.answer) : null
  return (
    <Swipeable quote={centralQuoteOf(r)} className="c-agent" style={colorVar(r.color)}>
      <div className="c-who">{r.who}</div>
      {(Array.isArray(r.notes) ? r.notes : []).map((n, i) => (
        <div key={i} className="c-note"><Markdown text={n} /></div>
      ))}
      {parsed?.clean && <div className="c-answer"><Markdown text={parsed.clean} /></div>}
      {parsed?.paths.map((path) => (
        <button key={path} type="button" className="c-dl" onClick={() => triggerDownload(client.fileUrl(path), path)}>
          <Icon name="download" size={15} /> <span>Baixar {basename(path)}</span>
        </button>
      ))}
      {(count > 0 || running) && (
        <button type="button" className={`c-act${open ? ' open' : ''}`} title={a?.text} onClick={() => count && toggleTurnTools(r)}>
          {running ? <span className="c-spin" /> : <Icon name="chevron" size={12} className="c-chev" />}
          <Segments r={r} />
          <span className="c-count">{count}</span>
        </button>
      )}
      {open && <TurnTools r={r} />}
      <button type="button" className="c-open" onClick={() => openDestination(r.anchor)}>
        <span>abrir</span> <Icon name="open" size={13} />
      </button>
    </Swipeable>
  )
}

export function CentralAnswered({ q }: { q: RemoteCentralAnswered }): JSX.Element {
  return (
    <div className="c-qdone" style={colorVar(q.color)}>
      <div className="c-who">{q.who}</div>
      <div className="c-qdone-q">{q.question}</div>
      <div className="c-qdone-a">
        <Icon name="check" size={12} className="c-check" />
        <span>{q.answer}</span>
      </div>
    </div>
  )
}
