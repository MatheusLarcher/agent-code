import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Composer } from '../components/Composer'
import { Markdown } from '../components/Markdown'
import { IconArrowLeft } from '../components/Icons'
import type { PickedElement } from '@shared/ipc'
import { PO_CHAT_QUICK, quickAboutCard, sourcesSentence, type PoChatMessage, type PoChatOption, type PoChatSource } from '@shared/poChat'
import type { PoChatState, PoChatVerifying } from './usePoChat'
import { PoChatSendPreview } from './PoChatSendPreview'
import '../central/central.css'
import '../central/centralFeed.css'
import './poChat.css'

/**
 * O "FALA, PO": o chat com o PO a partir do quadro, no lugar do chat principal
 * (como a Central), com o quadro aberto ao lado. O visual é o da Central —
 * orbe, bolhas, o mesmo Composer e os botões de opção (`central-opt`) — sem
 * seletor de modelo, tokens ou plano. Cada resposta diz de onde veio (chips que
 * abrem a conversa ou o card) e o que o PO oferece vira botão: verificar de
 * verdade (com o tempo correndo e "Cancelar"), corrigir o quadro (só no
 * clique), abrir o card, mandar um agente fazer.
 */

export const PO_CHAT_TITLE = 'Fala, PO'
const PO_COLOR = '#d97757'
const NO_CHIPS: PickedElement[] = []
const noop = (): void => {}

export interface PoChatPanelProps {
  projectCwd: string
  projectName: string
  state: PoChatState
  /** O cartão selecionado no quadro: o chip "Como está '<card>'?". */
  selectedCard: { id: string; title: string } | null
  onBack(): void
  onOpenConversation(convId: string): void
  onOpenCard(cardId: string, conversationId: string): void
  /** "Verificar de verdade (~N min)" (padrão: `state.verify`). */
  onVerify?(option: Extract<PoChatOption, { kind: 'verificar' }>, message: PoChatMessage): void
  /** "Mandar o agente … fazer" fora do padrão (o padrão abre a prévia com o texto exato). */
  onSend?(option: Extract<PoChatOption, { kind: 'mandar' }>, message: PoChatMessage): void
  /** O que vem embaixo da bolha do PO. */
  extra?(message: PoChatMessage): ReactNode
  /** A conversa dona dos cards está neste PC? (sem ela, o pedido vai numa conversa nova) */
  isLocalConversation?(conversationId: string): boolean
  /** Cria a conversa nova de implementação no projeto (o "Mandar fazer" sem a dona). */
  createConversation?(title: string): { id: string; title: string } | null
  /** "Ver na fila": o painel do quadro com a faixa "Próximos prompts". */
  onShowQueue?(): void
  composerRef?: RefObject<HTMLElement | null>
  now?: number
}

function SourceChips({ sources, onOpenConversation, onOpenCard }: { sources: PoChatSource[] } & Pick<PoChatPanelProps, 'onOpenConversation' | 'onOpenCard'>): JSX.Element | null {
  const chips = sources.filter((s) => s.kind === 'conversa' || s.kind === 'card')
  if (chips.length === 0) return null
  return (
    <div className="po-chat-sources" aria-label="Fontes">
      {chips.map((s) =>
        s.kind === 'conversa' ? (
          <button key={`c:${s.conversationId}`} type="button" className="po-chat-source" onClick={() => onOpenConversation(s.conversationId)} title="Abrir a conversa">
            💬 {s.title}
          </button>
        ) : s.kind === 'card' ? (
          <button key={`k:${s.cardId}`} type="button" className="po-chat-source card" onClick={() => onOpenCard(s.cardId, s.conversationId)} title="Abrir o card no quadro">
            {s.thumbUrl ? <img src={s.thumbUrl} alt="" /> : <span aria-hidden="true">🗂</span>}
            {s.title}
          </button>
        ) : null
      )}
    </div>
  )
}

export function optionLabel(o: PoChatOption): string {
  if (o.kind === 'verificar') return `Verificar de verdade (~${o.minutes} min)`
  if (o.kind === 'abrir-card') return `Abrir o card '${o.title}'`
  if (o.kind === 'abrir-conversa') return `Abrir a conversa '${o.title}'`
  if (o.kind === 'ver-fila') return 'Ver na fila'
  if (o.kind === 'mandar') {
    if (o.sent) return `✓ Mandado para '${o.sent.conversationTitle}'`
    return `Mandar o agente da conversa '${o.conversationTitle}' fazer: ${o.titles.join(', ')}`
  }
  const what = o.action === 'reabrir' ? `Reabrir '${o.title}'` : `Criar card para '${o.title}'`
  return o.applied ? `✓ ${what}` : what
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "verificando… 1:20" com o "Cancelar". */
function VerifyingBubble({ verifying, onCancel }: { verifying: PoChatVerifying; onCancel?(): void }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="central-agent po-chat-po po-chat-verifying" style={{ '--c': PO_COLOR } as CSSProperties} role="status">
      <span className="central-spin" aria-hidden="true" />{' '}
      <span>
        verificando… {clock(now - verifying.startedAt)} <span className="central-faint">(o PO estimou ~{verifying.minutes} min)</span>
      </span>
      {onCancel ? (
        <div className="central-opts">
          <button type="button" className="central-opt" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      ) : null}
    </div>
  )
}

interface BubbleProps extends Pick<PoChatPanelProps, 'onOpenConversation' | 'onOpenCard' | 'onShowQueue'> {
  message: PoChatMessage
  now: number
  verifyBusy: boolean
  onVerify?(option: Extract<PoChatOption, { kind: 'verificar' }>, message: PoChatMessage): void
  onApply?(message: PoChatMessage, index: number): void
  onSend?(message: PoChatMessage, index: number): void
  children?: ReactNode
}

function PoBubble(props: BubbleProps): JSX.Element {
  const { message: m } = props
  const choose = (o: PoChatOption, index: number): void => {
    if (o.kind === 'verificar') props.onVerify?.(o, m)
    else if (o.kind === 'abrir-card') props.onOpenCard(o.cardId, o.conversationId)
    else if (o.kind === 'abrir-conversa') props.onOpenConversation(o.conversationId)
    else if (o.kind === 'ver-fila') props.onShowQueue?.()
    else if (o.kind === 'mandar') props.onSend?.(m, index)
    else props.onApply?.(m, index)
  }
  const disabled = (o: PoChatOption): boolean =>
    (o.kind === 'verificar' && (!props.onVerify || props.verifyBusy)) ||
    (o.kind === 'mandar' && (!props.onSend || !!o.sent)) ||
    (o.kind === 'ver-fila' && !props.onShowQueue) ||
    (o.kind === 'corrigir' && (!props.onApply || !!o.applied))
  return (
    <div className="central-agent po-chat-po" style={{ '--c': PO_COLOR } as CSSProperties}>
      <div className="central-who">
        <span className="po-chat-who">PO{m.verified ? ' · verificado' : ''}</span>
      </div>
      <div className="po-chat-text central-answer">
        <Markdown text={m.text} />
      </div>
      {m.error ? <div className="po-chat-error">{m.error}</div> : null}
      {m.verified && m.difference ? <div className="po-chat-unconfirmed">Diferença da resposta rápida: {m.difference}</div> : null}
      {m.verified && m.evidence && m.evidence.length > 0 ? (
        <ul className="po-chat-evidence" aria-label="Evidências">
          {m.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
      {!m.error && m.sources ? <div className="po-chat-based central-faint">{sourcesSentence(m.sources, props.now)}</div> : null}
      {m.sources ? <SourceChips sources={m.sources} onOpenConversation={props.onOpenConversation} onOpenCard={props.onOpenCard} /> : null}
      {m.unconfirmed ? <div className="po-chat-unconfirmed">⚠ Não confirmado: {m.unconfirmed}</div> : null}
      {m.options && m.options.length > 0 ? (
        <div className="central-opts">
          {m.options.map((o, i) => (
            <button key={i} type="button" className="central-opt" onClick={() => choose(o, i)} disabled={disabled(o)}>
              {optionLabel(o)}
            </button>
          ))}
        </div>
      ) : null}
      {props.children}
    </div>
  )
}

export function PoChatPanel(props: PoChatPanelProps): JSX.Element {
  const { state } = props
  const [draft, setDraft] = useState('')
  const feedRef = useRef<HTMLDivElement>(null)
  const localRef = useRef<HTMLElement | null>(null)
  const now = props.now ?? Date.now()
  const quick = [...PO_CHAT_QUICK, ...(props.selectedCard ? [quickAboutCard(props.selectedCard.title)] : [])]
  const onVerify = props.onVerify ?? (state.verify ? (o: Extract<PoChatOption, { kind: 'verificar' }>, m: PoChatMessage) => state.verify!(m.id, o.minutes) : undefined)
  const onApply = state.apply ? (m: PoChatMessage, index: number) => state.apply!(m.id, index) : undefined
  // "Mandar fazer": o clique abre a prévia; só o "Mandar" dela manda.
  const [preview, setPreview] = useState<{ messageId: string; index: number } | null>(null)
  const onSend =
    props.onSend || state.send
      ? (m: PoChatMessage, index: number): void => {
          const o = m.options?.[index]
          if (o?.kind !== 'mandar') return
          if (props.onSend) props.onSend(o, m)
          else setPreview({ messageId: m.id, index })
        }
      : undefined
  const ownerHere = (convId: string): boolean => props.isLocalConversation?.(convId) ?? true
  const confirm = (m: PoChatMessage, index: number): void => {
    const o = m.options?.[index]
    setPreview(null)
    if (o?.kind !== 'mandar' || !state.send) return
    if (ownerHere(o.conversationId)) return state.send(m.id, index)
    const conv = props.createConversation?.(`Pedido do PO: ${o.titles[0] ?? 'tarefas'}`)
    if (conv) state.send(m.id, index, { conversationId: conv.id, conversationTitle: conv.title })
  }

  // Resposta nova (ou a pergunta em voo): o feed desce até o fim.
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.messages.length, state.asking, state.verifying])

  return (
    <section className="chat-panel central-panel po-chat-panel" aria-label={PO_CHAT_TITLE}>
      <header className="central-head po-chat-head">
        <button type="button" className="central-back" onClick={props.onBack} title="Voltar à conversa de antes" aria-label="Voltar à conversa de antes">
          <IconArrowLeft size={13} />
          Voltar
        </button>
        <span className="central-orb small" aria-hidden="true" />
        <h1>{PO_CHAT_TITLE}</h1>
        <span className="po-chat-project central-faint">{props.projectName}</span>
      </header>

      <div className="central-feed" ref={feedRef}>
        {state.messages.length === 0 && !state.asking && (
          <p className="central-empty">Pergunte ao PO sobre as tarefas deste projeto. Ele responde com o que está no quadro e no que os agentes disseram.</p>
        )}
        {state.messages.map((m) =>
          m.role === 'usuario' ? (
            <div key={m.id} className="central-me">
              <div className="central-bubble">{m.text}</div>
            </div>
          ) : (
            <PoBubble
              key={m.id}
              message={m}
              now={now}
              verifyBusy={!!state.verifying}
              onOpenConversation={props.onOpenConversation}
              onOpenCard={props.onOpenCard}
              onShowQueue={props.onShowQueue}
              onVerify={onVerify}
              onApply={onApply}
              onSend={onSend}
            >
              {props.extra?.(m)}
              {preview?.messageId === m.id && m.options?.[preview.index]?.kind === 'mandar' ? (
                <PoChatSendPreview
                  option={m.options[preview.index] as Extract<PoChatOption, { kind: 'mandar' }>}
                  ownerHere={ownerHere((m.options[preview.index] as Extract<PoChatOption, { kind: 'mandar' }>).conversationId)}
                  onConfirm={() => confirm(m, preview.index)}
                  onCancel={() => setPreview(null)}
                />
              ) : null}
            </PoBubble>
          )
        )}
        {state.verifying && <VerifyingBubble verifying={state.verifying} onCancel={state.cancel} />}
        {state.asking && (
          <>
            <div className="central-me">
              <div className="central-bubble">{state.asking}</div>
            </div>
            <div className="central-agent po-chat-po" style={{ '--c': PO_COLOR } as CSSProperties}>
              <span className="central-spin" aria-hidden="true" /> <span className="central-faint">o PO está olhando o quadro…</span>
            </div>
          </>
        )}
        {state.error && <p className="po-chat-error">{state.error}</p>}
      </div>

      <div className="central-composer">
        <div className="po-chat-quick" aria-label="Perguntas prontas">
          {quick.map((q) => (
            <button key={q} type="button" className="po-chat-chip" disabled={!!state.asking} onClick={() => state.ask(q)}>
              {q}
            </button>
          ))}
        </div>
        <Composer
          disabled={false}
          busy={false}
          chips={NO_CHIPS}
          onChipsConsumed={noop}
          onSend={(text) => {
            setDraft('')
            state.ask(text)
          }}
          // Uma pergunta por vez: com a resposta em voo, o texto fica no campo.
          beforeSend={() => !state.asking}
          onInterrupt={noop}
          textareaRef={props.composerRef ?? localRef}
          projects={[]}
          projectRoot={null}
          convId={`po-chat:${props.projectCwd}`}
          draft={draft}
          onDraftChange={(_id, text) => setDraft(text)}
          projectMissing={false}
          projectMissingMsg=""
          placeholder="Pergunte ao PO…"
          hideCodeReview
        />
      </div>
    </section>
  )
}
