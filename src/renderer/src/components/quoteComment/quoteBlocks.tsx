/**
 * Os blocos "comentáveis" da resposta do agente: parágrafo, item de lista,
 * título e bloco de código ganham os botões discretos "Comentar" e "Ler daqui"
 * (aparecem no hover e no foco — ver quoteComment.css), e ficam destacados quando o trecho
 * está no campo de mensagem ou já foi comentado no histórico.
 *
 * Tudo depende do contexto que o MessageList põe em volta de CADA mensagem do
 * agente (`QuotableMessage`). Sem ele — mensagem do usuário, prévia de arquivo,
 * qualquer outro uso do Markdown — o bloco sai exatamente como sempre.
 */
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type HTMLAttributes,
  type ReactNode
} from 'react'
import type { ExtraProps } from 'react-markdown'
import { IconSpeaker, IconStopSmall } from '../Icons'
import { readFromText } from './readFrom'
import './quoteComment.css'

/** 'pending': o trecho está no campo de mensagem ("[trecho N]"); 'commented': já foi enviado. */
export type QuoteMark = 'pending' | 'commented' | null

/** O que a lista de mensagens oferece (vem do useQuoteComments, no ChatPanel). */
export interface QuoteListApi {
  markOf: (messageId: string, blockText: string) => QuoteMark
  add: (messageId: string, blockText: string) => void
}

/** "Ler daqui": o mesmo TTS do botão "Ouvir" da mensagem (TtsControls do MessageList). */
export interface QuoteReadApi {
  speakingId: string | null
  onToggleSpeak: (id: string, text: string) => void
}

/** A mesma coisa já presa a uma mensagem: é o que cada bloco enxerga. */
interface QuoteBlockApi {
  markOf: (blockText: string) => QuoteMark
  comment: (blockText: string) => void
  /** Sem TTS em volta, não há "Ler daqui". */
  read?: { speaking: (blockText: string) => boolean; toggle: (blockText: string) => void }
}

/** Id da leitura "daqui": a mensagem + onde o trecho começa (outro bloco = outra leitura).
 *  Bloco não achado no texto: o próprio trecho distingue (lê só ele). */
const readPrefix = (messageId: string): string => `${messageId}#ler:`
const readId = (messageId: string, start: number, text: string): string =>
  `${readPrefix(messageId)}${start >= 0 ? start : `?${text}`}`

const QuoteBlockContext = createContext<QuoteBlockApi | null>(null)

/** Há uma mensagem comentável em volta? (o Markdown escolhe os componentes por isso) */
export function useQuotableBlocks(): boolean {
  return useContext(QuoteBlockContext) !== null
}

/** Liga os blocos de UMA mensagem do agente. Sem `api`, nada muda; sem `read`, não há "Ler daqui".
 *  `source` é o texto-fonte (Markdown) da mensagem — de onde sai o trecho "do bloco até o fim". */
export function QuotableMessage({
  api,
  messageId,
  read,
  source = '',
  children
}: {
  api?: QuoteListApi | null
  messageId: string
  read?: QuoteReadApi | null
  source?: string
  children: ReactNode
}): JSX.Element {
  const value = useMemo<QuoteBlockApi | null>(() => {
    if (!api) return null
    const at = (text: string): { id: string; text: string } => {
      const r = readFromText(source, text)
      return { id: readId(messageId, r.start, r.text), text: r.text }
    }
    return {
      markOf: (text) => api.markOf(messageId, text),
      comment: (text) => api.add(messageId, text),
      read: read
        ? {
            // Só procura o bloco no texto se a leitura em curso é "daqui" nesta mensagem.
            speaking: (text) =>
              !!read.speakingId?.startsWith(readPrefix(messageId)) &&
              read.speakingId === at(text).id,
            toggle: (text) => {
              const r = at(text)
              read.onToggleSpeak(r.id, r.text)
            }
          }
        : undefined
    }
  }, [api, messageId, read, source])
  return <QuoteBlockContext.Provider value={value}>{children}</QuoteBlockContext.Provider>
}

/** O pedaço do nó hast que interessa aqui (o react-markdown passa o nó em `node`). */
interface HastLike {
  type: string
  tagName?: string
  value?: string
  children?: HastLike[]
}

/** O texto visível do bloco — o mesmo que o `textContent` dele na tela, sem o
 *  botão. Vem do nó (não do DOM), então o destaque já sai no primeiro render. */
export function hastText(node: HastLike | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

// Item de lista "solto" (com parágrafo dentro): os parágrafos já são os blocos.
const INNER_BLOCKS = new Set(['p', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const hasInnerBlock = (node: HastLike | undefined): boolean =>
  !!node?.children?.some((c) => c.type === 'element' && INNER_BLOCKS.has(c.tagName ?? ''))

function CommentButton({ onComment }: { onComment: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="qc-btn"
      aria-label="Comentar este trecho"
      title="Comentar este trecho (entra como [trecho N] no ponto do cursor do campo de mensagem)"
      // O clique não tira o foco do campo de mensagem: o trecho entra no cursor dele.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onComment}
    >
      ↳ Comentar
    </button>
  )
}

/** "Ler daqui": o TTS da mensagem a partir deste bloco; tocando, vira "Parar". */
function ReadButton({ speaking, onToggle }: { speaking: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className={`qc-btn qc-read${speaking ? ' active' : ''}`}
      aria-label={speaking ? 'Parar leitura' : 'Ler daqui'}
      title={speaking ? 'Parar leitura' : 'Ler em voz alta a partir deste trecho até o fim da mensagem'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onToggle}
    >
      {speaking ? <IconStopSmall size={11} /> : <IconSpeaker size={12} />}
      {speaking ? 'Parar' : 'Ler daqui'}
    </button>
  )
}

/** Os botões do bloco, lado a lado no canto: "Ler daqui" (se há TTS) e "Comentar". */
function BlockActions({ api, text }: { api: QuoteBlockApi; text: string }): JSX.Element {
  return (
    <span className="qc-actions">
      {api.read && <ReadButton speaking={api.read.speaking(text)} onToggle={() => api.read?.toggle(text)} />}
      <CommentButton onComment={() => api.comment(text)} />
    </span>
  )
}

type BlockProps = ExtraProps & HTMLAttributes<HTMLElement>

const markClass = (mark: QuoteMark): string => (mark ? ` qc-${mark}` : '')

/** p, li e h1–h6: o botão entra no próprio elemento (a estrutura não muda). */
function inlineBlock(tag: string): (props: BlockProps) => JSX.Element {
  function QuotableBlock({ node, children, className, ...rest }: BlockProps): JSX.Element {
    const api = useContext(QuoteBlockContext)
    const text = hastText(node)
    // Título escondido (o "Footnotes" do GFM, sr-only) não ganha botão invisível no Tab.
    const hidden = /(^|\s)sr-only(\s|$)/.test(className ?? '')
    if (!api || !text.trim() || hidden || (tag === 'li' && hasInnerBlock(node))) {
      return createElement(tag, { ...rest, className }, children)
    }
    const cls = `${className ? `${className} ` : ''}qc-block${markClass(api.markOf(text))}`
    return createElement(
      tag,
      { ...rest, className: cls },
      children,
      <BlockActions key="qc" api={api} text={text} />
    )
  }
  QuotableBlock.displayName = `Quotable(${tag})`
  return QuotableBlock
}

/** Bloco de código: um invólucro leva o botão, fora da área que rola do <pre>. */
function QuotablePre({ node, children, ...rest }: BlockProps): JSX.Element {
  const api = useContext(QuoteBlockContext)
  const text = hastText(node)
  if (!api || !text.trim()) return <pre {...rest}>{children}</pre>
  return (
    <div className={`qc-block qc-pre${markClass(api.markOf(text))}`}>
      <pre {...rest}>{children}</pre>
      <BlockActions api={api} text={text} />
    </div>
  )
}

/** Os componentes que o Markdown usa quando há uma mensagem comentável em volta. */
export const quoteBlockComponents = {
  p: inlineBlock('p'),
  li: inlineBlock('li'),
  h1: inlineBlock('h1'),
  h2: inlineBlock('h2'),
  h3: inlineBlock('h3'),
  h4: inlineBlock('h4'),
  h5: inlineBlock('h5'),
  h6: inlineBlock('h6'),
  pre: QuotablePre
}
