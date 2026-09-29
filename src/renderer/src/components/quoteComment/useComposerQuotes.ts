/**
 * O lado do Composer no "Comentar": os trechos são anexos inline do campo
 * (quoteToken.ts), então quem os insere, renumera e conta é o Composer. O
 * ChatPanel fala com ele por um `ComposerQuoteLink`:
 * - `inserterRef`: o Composer põe ali o `insert` (chamado no clique em "Comentar");
 * - `onChange`: o Composer avisa os trechos que estão no campo, na ordem do texto
 *   (é o destaque "pendente" dos blocos da resposta).
 */
import { useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import type { EditorElement } from '../../inlineMedia/InlineEditor'
import type { InlineAtt } from '../../inlineMedia/inlineAttachments'
import type { Quote } from './quoteFormat'
import { makeQuoteAtt, quotesInOrder } from './quoteToken'

/** 'dup': o mesmo trecho já está no campo; 'locked': campo travado (sem sessão, pasta sumida). */
export type InsertResult = 'ok' | 'dup' | 'locked'

export interface QuoteInserter {
  insert: (q: Quote) => InsertResult
}

export interface ComposerQuoteLink {
  inserterRef: MutableRefObject<QuoteInserter | null>
  onChange: (quotes: Quote[]) => void
}

/** O pedaço do useInlineAttachments que interessa aqui. */
interface MediaApi {
  atts: ReadonlyMap<string, InlineAtt>
  order: readonly string[]
  orderRef: RefObject<readonly string[]>
  version: number
  insertAtt: (att: InlineAtt, at?: number | null) => void
  replaceAtt: (id: string, att: InlineAtt) => void
}

const keyOf = (quotes: readonly Quote[]): string => JSON.stringify(quotes.map((q) => [q.messageId, q.text]))

/** Liga o campo ao "Comentar". Devolve quantos trechos há no campo agora. */
export function useComposerQuotes(
  media: MediaApi,
  editorRef: RefObject<EditorElement | null>,
  link: ComposerQuoteLink | undefined
): number {
  const mediaRef = useRef(media)
  mediaRef.current = media

  // O `insert` lê sempre o campo e os anexos mais novos (pelos refs).
  useLayoutEffect(() => {
    if (!link) return
    const inserter: QuoteInserter = {
      insert: (q) => {
        const el = editorRef.current
        if (!el || el.disabled || el.readOnly) return 'locked'
        const m = mediaRef.current
        const present = quotesInOrder(m.orderRef.current ?? [], m.atts)
        if (present.some((a) => a.quote.messageId === q.messageId && a.quote.text === q.text)) return 'dup'
        // Foco no campo: no cursor. Fora dele (clique pelo teclado no botão): no fim do texto.
        const focused = el.ownerDocument.activeElement === el
        m.insertAtt(makeQuoteAtt(q, present.length + 1), focused ? null : el.value.length)
        return 'ok'
      }
    }
    link.inserterRef.current = inserter
    return () => {
      if (link.inserterRef.current === inserter) link.inserterRef.current = null
    }
  }, [link, editorRef])

  // Renumera "[trecho N]" pela ordem no texto e avisa o ChatPanel quando a lista muda.
  const reported = useRef<string | null>(null)
  useEffect(() => {
    const quotes = quotesInOrder(media.order, media.atts)
    quotes.forEach((a, i) => {
      if (a.name !== `trecho ${i + 1}`) media.replaceAtt(a.id, makeQuoteAtt(a.quote, i + 1, a.id))
    })
    const list = quotes.map((a) => a.quote)
    const key = keyOf(list)
    if (!link || reported.current === key) return
    reported.current = key
    link.onChange(list)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.order, media.version, link])

  return quotesInOrder(media.order, media.atts).length
}
