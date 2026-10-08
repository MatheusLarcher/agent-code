import { memo, useEffect, useMemo, useRef, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { rehypeBlurBlock, type BlurBlockState } from '../chatAnim'
import { splitMarkdownBlocks } from './markdownBlocks'
import type { PlanningCardType } from '@shared/ipc'
import { refHrefTipo, refsToMarkdownLinks, splitRefs, type RefCard } from '../planning/cardRefs'
import { CARD_TYPE_LABEL, typeColorVar } from '../planning/cardTypes'
import { quoteBlockComponents, useQuotableBlocks } from './quoteComment/quoteBlocks'

/** Rótulo de [[...]] → card do plano (null = não é um card: fica como texto). */
export type CardRefResolver = (label: string) => RefCard | null

// Links must open in the system browser, not navigate the app frame. Forcing
// target=_blank routes the click through the main process' window-open handler
// (shell.openExternal), so the Electron renderer never navigates away.
const mdComponents = {
  a: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />
}

/** [[Nome]] que resolveu: o nome com a cor do tipo do card (a mesma do canvas). */
export function CardRefChip({ tipo, children }: { tipo: string; children: ReactNode }): JSX.Element {
  const known = Object.prototype.hasOwnProperty.call(CARD_TYPE_LABEL, tipo) ? (tipo as PlanningCardType) : 'nota'
  return (
    <span
      className="pl-card-ref"
      data-tipo={known}
      title={CARD_TYPE_LABEL[known]}
      style={{ '--pl-ref': typeColorVar(known) } as CSSProperties}
    >
      {children}
    </span>
  )
}

// Com referências: o link '#card-ref/<tipo>/<id>' (refsToMarkdownLinks) vira a
// pílula colorida — não é link, não navega. Os outros links seguem como acima.
const mdComponentsWithRefs = {
  a: (props: ComponentPropsWithoutRef<'a'>) => {
    const tipo = refHrefTipo(props.href)
    return tipo ? <CardRefChip tipo={tipo}>{props.children}</CardRefChip> : mdComponents.a(props)
  }
}

// Resposta do agente no chat (QuotableMessage em volta): parágrafo, item, título
// e código ganham o "Comentar" (ver quoteComment/). Fora dela, os mapas de cima.
const mdQuotable = { ...mdComponents, ...quoteBlockComponents }
const mdQuotableWithRefs = { ...mdComponentsWithRefs, ...quoteBlockComponents }

// Fora do componente: um array novo a cada render faria o react-markdown reprocessar tudo.
const REMARK_PLUGINS = [remarkGfm]
const NO_PLUGINS: never[] = []

type MdComponents = typeof mdComponents | typeof mdComponentsWithRefs | typeof mdQuotable | typeof mdQuotableWithRefs

/** Um bloco da resposta: em memo, só é reprocessado quando o texto dele (ou o ponto
 *  onde a numeração do borrado começa) muda — no streaming, só o último. */
const MarkdownBlock = memo(function MarkdownBlock({
  source,
  components,
  blur,
  shared,
  index,
  offset
}: {
  source: string
  components: MdComponents
  blur: boolean
  shared: BlurBlockState
  index: number
  offset: number
}): JSX.Element {
  const rehypePlugins = useMemo(() => (blur ? [rehypeBlurBlock(shared, index, offset)] : NO_PLUGINS), [blur, shared, index, offset])
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={components}>
      {source}
    </ReactMarkdown>
  )
})

/** Render text as GitHub-flavored Markdown (headings, lists, code, tables, …).
 *  Safe: react-markdown builds React nodes, no raw HTML. Shared by the chat
 *  (assistant answers) and the file preview (.md "Janela de Arquivo").
 *  `resolveRef` (só o chat do Agent Manager): [[Nome]] de um card vira a pílula
 *  com a cor do tipo; sem ele, o texto sai exatamente como sempre.
 *  Em memo e POR BLOCO (markdownBlocks.ts): no streaming, o texto que muda é só o
 *  do último bloco — os anteriores não são processados de novo a cada pedaço. */
export const Markdown = memo(function Markdown({
  text,
  resolveRef,
  blur = false
}: {
  text: string
  resolveRef?: CardRefResolver | null
  /** Texto que chegou ao vivo: cada palavra entra borrada→nítida (chatAnim). Fixo por montagem. */
  blur?: boolean
}): JSX.Element {
  const source = useMemo(() => (resolveRef ? refsToMarkdownLinks(text, resolveRef) : text), [text, resolveRef])
  const blocks = useMemo(() => splitMarkdownBlocks(source), [source])
  const quotable = useQuotableBlocks()
  const components = quotable
    ? resolveRef ? mdQuotableWithRefs : mdQuotable
    : resolveRef ? mdComponentsWithRefs : mdComponents
  // BlurText: cada bloco numera as palavras continuando de onde os anteriores pararam;
  // depois de pintar, as que já estão na tela viram a base (o pedaço novo do streaming
  // entra em cascata a partir dali, o resto não recomeça).
  const words = useRef<BlurBlockState>({ base: 0, counts: [] })
  useEffect(() => {
    words.current.counts.length = blocks.length
    words.current.base = words.current.counts.reduce((sum, count) => sum + (count ?? 0), 0)
  })
  let offset = 0
  return (
    <div className="md">
      {blocks.map((block, index) => {
        const start = offset
        offset += words.current.counts[index] ?? 0
        return (
          <MarkdownBlock key={index} source={block} components={components} blur={blur} shared={words.current} index={index} offset={start} />
        )
      })}
    </div>
  )
})

/** Texto puro (a mensagem do usuário) com [[Nome]] de card destacado como no Markdown. */
export function CardRefText({ text, resolveRef }: { text: string; resolveRef: CardRefResolver }): JSX.Element {
  return (
    <>
      {splitRefs(text, resolveRef).map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <CardRefChip key={i} tipo={part.card.tipo}>
            {part.label}
          </CardRefChip>
        )
      )}
    </>
  )
}
