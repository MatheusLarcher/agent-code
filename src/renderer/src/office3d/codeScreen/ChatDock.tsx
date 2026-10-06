/**
 * O app Código com o Chat à direita, como o chat do Copilot na barra lateral
 * secundária do VS Code: [editor] | borda | [Chat], e a barra de status na
 * janela inteira, embaixo dos dois (maquete aprovada f3182b). Um monitor por
 * PC: editor, prévia e chat dividem a mesma tela.
 *
 * No Contexto o Chat sai da tela (o Contexto ocupa a janela), mas o campo de
 * digitar fica montado, escondido: trocar de app não perde o rascunho.
 *
 * A largura do Chat é em px (monitorPrefs.chatWidth): padrão 400, de 280 até
 * 60% da tela sem deixar o editor com menos de 320 px. Relida limitada pela
 * tela de agora e gravada só quando o usuário solta a borda (PaneSplitter),
 * sem aviso — vale para todos os monitores. Tela estreita (`narrow`): o Chat
 * ocupa a janela e o editor some.
 */
import './chatDock.css'
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { clampPane, PaneSplitter } from '../../components/PaneSplitter'
import { QuoteLinkContext } from '../../components/quoteComment/useComposerQuotes'
import { useQuoteComments, type QuoteComments } from '../../components/quoteComment/useQuoteComments'
import { ToolFileOpenContext, type ToolFileOpen } from '../../components/toolFileOpen'
import { TtsContext } from '../../components/ttsContext'
import type { TurnHead } from '../chatPage'
import { ChatPanel, type ChatContent } from '../ChatScreen'
import { CHAT_MIN_W, maxChatWidth, monitorPrefs } from './monitorPrefs'

/** Abaixo disto (px de layout da tela) o editor não cabe ao lado do Chat. */
export const NARROW_W = 700

/** Largura de layout de um elemento, acompanhada (0 = ainda não medida, como nos testes). */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setWidth(el.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

export interface ChatDockProps {
  /** O Chat à vista (o app Código); no Contexto ele fica montado e escondido. */
  chatOn: boolean
  /** A tela é estreita demais para o editor ao lado: o Chat ocupa a janela. */
  narrow: boolean
  /** O editor (CodeView) ou o Contexto; null = nada à esquerda. */
  children: ReactNode
  /** O conteúdo do painel Chat (MonitorChat). */
  chat: ReactNode
  /** A barra de status (só no Código), na janela inteira. */
  status?: ReactNode
}

export function ChatDock({ chatOn, narrow, children, chat, status }: ChatDockProps): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const rowW = useWidth(rowRef)
  const [width, setWidth] = useState(() => monitorPrefs.chatWidth())
  // O que fica fixo à esquerda do editor (atividades + explorador + a borda), lido do DOM.
  const fixedLeft = useCallback((): number => {
    const row = rowRef.current
    const w = (sel: string): number => row?.querySelector<HTMLElement>(sel)?.offsetWidth ?? 0
    return w('.cm-activity') + w('.cm-explorer') + 1
  }, [])
  const [left, setLeft] = useState(0)
  // O explorador abre e fecha: o teto do Chat acompanha (só regrava o estado quando muda).
  useLayoutEffect(() => {
    const v = fixedLeft()
    if (v !== left) setLeft(v)
  })
  const getMax = useCallback((): number => maxChatWidth(rowRef.current?.clientWidth ?? 0, fixedLeft()), [fixedLeft])
  const shown = clampPane(width, CHAT_MIN_W, maxChatWidth(rowW, left))
  const split = chatOn && !narrow

  return (
    <div className={`cm-dock${chatOn && narrow ? ' narrow' : ''}`} data-chat={chatOn ? 'on' : 'off'}>
      <div className="cm-dock-row" ref={rowRef}>
        {children ? <div className="cm-dock-main">{children}</div> : null}
        {split && (
          <PaneSplitter
            className="cm-sash"
            side="end"
            label="Largura do chat"
            title="Arraste para mudar a largura do chat"
            width={shown}
            min={CHAT_MIN_W}
            getMax={getMax}
            onResize={setWidth}
            onCommit={(w) => {
              setWidth(w)
              monitorPrefs.setChatWidth(w)
            }}
          />
        )}
        <aside className="cm-chatpane" data-testid="office-screen-chat" aria-label="Chat" hidden={!chatOn} style={split ? { width: `${shown}px` } : undefined}>
          {chat}
        </aside>
      </div>
      {status}
    </div>
  )
}

export type ChatState = 'busy' | 'idle' | 'you'

const STATE_LABEL: Record<ChatState, string> = { busy: 'trabalhando', idle: 'parado', you: 'aguardando você' }

export interface MonitorChatProps {
  head: TurnHead
  seed: string
  content: ChatContent
  /** Quem e o modelo ("Agent principal · Opus 5.5"). */
  who: string
  state: ChatState
  /** O campo de digitar (o Composer do App) e o seletor de modelo, embaixo. Com ele, os blocos da resposta ganham "Comentar". */
  composer?: ReactNode
  /** O Contexto à vista: só o campo fica montado, escondido (sem perder o rascunho); o turno sai. */
  hidden: boolean
  /** Abre os arquivos dos cartões no editor ao lado; null (tela estreita): os cartões só expandem. */
  opener: ToolFileOpen | null
  /** Muda para ir ao fim do chat; com `focus`, o campo ganha o foco. */
  go: { n: number; focus: boolean }
}

/**
 * O painel Chat: o cabeçalho compacto da maquete, o turno (ChatPanel) e o campo
 * embaixo, com o "Ouvir" e o "Comentar" da aba Conversa. "Ouvir" (e o "Ler
 * daqui" dos blocos) é o TTS do App, lido do TtsContext que o App põe em volta
 * do Escritório — sem ele, nada. "Comentar" só com o campo na tela: o trecho
 * entra como "[trecho N]" no Composer do App pelo QuoteLinkContext. O estado dos
 * trechos (useQuoteComments, que pede o UiProvider) mora num filho montado só
 * com o campo: quem monta sem campo (e sem o provider) segue como antes.
 */
export function MonitorChat(props: MonitorChatProps): JSX.Element {
  return props.composer ? <QuotedChat {...props} /> : <ChatBody {...props} quote={null} />
}

/** Com o campo: os trechos do "Comentar" deste turno. */
function QuotedChat(props: MonitorChatProps): JSX.Element {
  const quote = useQuoteComments(props.content.messages)
  return <ChatBody {...props} quote={quote} />
}

function ChatBody({ head, seed, content, who, state, composer, hidden, opener, go, quote }: MonitorChatProps & { quote: QuoteComments | null }): JSX.Element {
  const tts = useContext(TtsContext)
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (go.n === 0 || !go.focus) return
    boxRef.current?.querySelector<HTMLElement>('textarea, [role="textbox"]')?.focus()
  }, [go])
  return (
    <ToolFileOpenContext.Provider value={opener}>
      {!hidden && (
        <ChatPanel
          head={head}
          seed={seed}
          content={content}
          endSignal={go.n}
          tts={tts}
          quote={quote?.list}
          header={
            <div className="cm-chat-head">
              <span className="cm-chat-dot" aria-hidden="true" />
              <span className="cm-chat-ttl">Chat</span>
              <span className="cm-chat-who" title={who}>
                {who}
              </span>
              <span className={`cm-chat-state ${state}`}>
                {state === 'busy' && <span className="cm-chat-pulse" aria-hidden="true" />}
                {STATE_LABEL[state]}
              </span>
            </div>
          }
        />
      )}
      {composer ? (
        <div className="cm-composer" data-testid="office-screen-composer" hidden={hidden} ref={boxRef}>
          <QuoteLinkContext.Provider value={quote?.link ?? null}>{composer}</QuoteLinkContext.Provider>
        </div>
      ) : null}
    </ToolFileOpenContext.Provider>
  )
}
