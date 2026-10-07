/**
 * O painel da Central (no lugar do ChatPanel quando ela é a conversa aberta, e
 * no chat flutuante do Escritório): cabeçalho com o orbe e o trilho das
 * conversas trabalhando agora, o feed (pedidos com o aviso do destino, "Para
 * onde vai?", respostas com a linha-resumo, perguntas dos destinos) e o MESMO
 * Composer do chat. Tudo vem do controller (useCentral.ts); a tela não decide
 * nada. Sem seletor de modelo, tokens, plano ou recuperação: a Central encaminha.
 * O feed pagina como o chat (useScrollWindow): as últimas entradas, mais ao chegar
 * perto do topo, sem pular; pendentes sempre no fim.
 *
 * Cores: cada destino na sua (`--c`); o laranja é só da Central (orbe, enviar,
 * opção mais provável). Classes que o office3d.css lê: central-head,
 * central-head-rail, central-hint, central-feed, central-bubble.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react'
import type { FileAttachment, FileRefAttachment, ImageAttachment, PickedElement } from '@shared/ipc'
import { CENTRAL_ID, CENTRAL_TITLE, type CentralEntry, type CentralReplyQuote } from '@shared/central'
import { replyQuoteOf } from './centralReplyTo'
import { ReplyMenu, ReplyQuote } from './CentralReplyUi'
import './centralReply.css'
import { Composer, type RefProject } from '../components/Composer'
import { loadMoreText, useScrollWindow } from '../components/useScrollWindow'
import type { DraftMedia } from '../inlineMedia/inlineAttachments'
import type { Conversation } from '../types'
import type { CentralController } from './useCentral'
import { isOwnEntry } from './centralEntries'
import { injectedIds } from './centralView'
import { CentralRail } from './CentralRail'
import { CentralRequest } from './CentralRequest'
import { CentralReply } from './CentralReply'
import { CentralAnswered, CentralPending } from './CentralPending'
import './central.css'
import './centralFeed.css'

export interface CentralPanelProps {
  /** A Central (a conversa de id fixo): rascunho do campo. */
  conversation: Conversation
  /** O fluxo da Central (useCentral.ts): entradas, trilho, perguntas e ações. */
  controller: CentralController
  /** `installationId` deste PC: pedido de outro PC aparece sem ações. */
  self?: string
  /** Abre o QuestionModal da pergunta pendente desse destino (várias perguntas,
   *  múltipla escolha, "outro…"). Sem ele, abre a conversa (o modal está lá). */
  onOpenQuestion?: (convId: string) => void
  /** TypeSafe configurado. Sem ele, enviar abre as Configurações e o texto fica no campo. */
  ready: boolean
  /** O gate: aviso da Central + Configurações no TypeSafe. */
  onNeedTypesafe: () => void
  onSend: (
    text: string,
    images: ImageAttachment[],
    thumbs: string[],
    files: FileAttachment[],
    fileRefs: FileRefAttachment[],
    /** Id da entrada respondida (modo resposta): vai direto à conversa dela. */
    replyTo?: string
  ) => void
  onDraftChange: (convId: string, text: string, media?: DraftMedia[]) => void
  /** O campo de texto (o App usa para dar foco). */
  composerRef: RefObject<HTMLElement | null>
  /** Projetos do histórico, no menu "@" do Composer. */
  projects: RefProject[]
}

// Elementos marcados no navegador ficam para o chat normal: a Central não os consome.
const NO_CHIPS: PickedElement[] = []
const noop = (): void => {}
/** Até aqui do fim conta como "no fim": o feed acompanha o que chega. */
const STICK_PX = 80

export function CentralPanel(props: CentralPanelProps): JSX.Element {
  const c = props.controller
  const { entries, pending } = c
  const injected = useMemo(() => injectedIds(entries), [entries])
  const open = (convId: string, msgId?: string): void => c.openDestination(convId, msgId)
  const openQuestion = props.onOpenQuestion ?? ((convId: string) => c.openDestination(convId))

  const feedRef = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  // Como o chat: só as últimas entradas (a mesma página), +1 página perto do topo sem
  // pular a leitura. Pendentes ficam fora da janela — sempre à vista no fim.
  const shownEntries = useMemo(() => entries.filter((e) => !(e.kind === 'reply' && injected.has(e.requestId))), [entries, injected])
  const win = useScrollWindow(feedRef, shownEntries.length, {
    isAtEnd: () => atBottom.current,
    anchorSelector: '[data-entry-id], .central-ask, .central-answered'
  })
  const lastRequest = [...entries].reverse().find((e) => e.kind === 'request')?.id
  const seenRequest = useRef(lastRequest)
  // Pedido novo do usuário: desce sempre. O resto (espelho, perguntas): só se já estava no fim.
  useLayoutEffect(() => {
    const el = feedRef.current
    if (!el) return
    const newRequest = lastRequest !== seenRequest.current
    seenRequest.current = lastRequest
    if (newRequest || atBottom.current) el.scrollTop = el.scrollHeight
  }, [entries, pending, lastRequest])

  // Modo resposta (estilo WhatsApp): a citação fica acima do campo até enviar, × ou Esc.
  const [replying, setReplying] = useState<CentralReplyQuote | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; quote: CentralReplyQuote } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const startReply = (quote: CentralReplyQuote): void => {
    setReplying(quote)
    props.composerRef.current?.focus()
  }
  const replyFor = (entry: CentralEntry): (() => void) | undefined => {
    const quote = replyQuoteOf(entry, props.self)
    return quote ? () => startReply(quote) : undefined
  }
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const id = (e.target as HTMLElement).closest?.('[data-entry-id]')?.getAttribute('data-entry-id')
    const quote = id ? replyQuoteOf(entries.find((x) => x.id === id), props.self) : null
    if (!quote) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, quote })
  }

  const send = (text: string, images: ImageAttachment[], files: FileAttachment[], fileRefs: FileRefAttachment[]): void => {
    const thumbs = images.map((img) => `data:${img.mediaType};base64,${img.data}`)
    if (replying) props.onSend(text, images, thumbs, files, fileRefs, replying.id)
    else props.onSend(text, images, thumbs, files, fileRefs)
    setReplying(null)
  }
  // Sem TypeSafe a mensagem não sai: o gate abre as Configurações e o Composer
  // recusa o envio sem limpar o campo — texto e anexos ficam para depois.
  const gate = (): boolean => {
    if (props.ready) return true
    props.onNeedTypesafe()
    return false
  }

  return (
    <section className="chat-panel central-panel" aria-label={CENTRAL_TITLE}>
      <header className="central-head">
        <span className="central-orb small" aria-hidden="true" />
        <h1>{CENTRAL_TITLE}</h1>
        <CentralRail rail={c.rail} entries={entries} onOpen={open} />
      </header>

      <div
        className="central-feed"
        ref={feedRef}
        onContextMenu={onContextMenu}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
          win.onScrollTop()
        }}
      >
        {entries.length === 0 && pending.length === 0 && (
          <p className="central-empty">Diga o que precisa: a Central leva para a conversa certa.</p>
        )}
        {win.hasOlder && <div className="load-more-hint">{loadMoreText(win.start)}</div>}
        {shownEntries.slice(win.start).map((e) => {
          if (e.kind === 'request') {
            return (
              <CentralRequest
                key={e.id}
                entry={e}
                own={isOwnEntry(e, props.self)}
                labelFor={c.labelFor}
                onOpen={open}
                onNotHere={(id) => void c.notHere(id)}
                onChoose={(id, i) => void c.choose(id, i)}
                onReply={replyFor(e)}
              />
            )
          }
          if (e.kind === 'reply') {
            // A1: ajuste injetado não tem resposta própria (já fora de `shownEntries`).
            return <CentralReply key={e.id} reply={e} labelFor={c.labelFor} turnTools={c.turnTools} onOpen={open} onReply={replyFor(e)} />
          }
          return <CentralAnswered key={e.id} entry={e} labelFor={c.labelFor} />
        })}
        <CentralPending pending={pending} answer={(convId, res) => void c.answer(convId, res)} onOpenQuestion={openQuestion} />
      </div>

      {menu && <ReplyMenu x={menu.x} y={menu.y} onReply={() => startReply(menu.quote)} onClose={closeMenu} />}

      <div
        className="central-composer"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && replying) {
            e.stopPropagation()
            setReplying(null)
          }
        }}
      >
        {replying && <ReplyQuote quote={replying} labelFor={c.labelFor} onCancel={() => setReplying(null)} />}
        {/* Sem o escudo de revisão: a Central não tem projeto para revisar. */}
        <Composer
          disabled={false}
          busy={false}
          chips={NO_CHIPS}
          onChipsConsumed={noop}
          onSend={send}
          onInterrupt={noop}
          textareaRef={props.composerRef}
          projects={props.projects}
          projectRoot={null}
          convId={CENTRAL_ID}
          draft={props.conversation.draft ?? ''}
          draftMedia={props.conversation.draftMedia}
          onDraftChange={props.onDraftChange}
          projectMissing={false}
          projectMissingMsg=""
          placeholder="Fale com o agent…"
          hideCodeReview
          beforeSend={gate}
        />
        <div className="central-hint">o destino é escolhido pelo assunto</div>
      </div>
    </section>
  )
}
