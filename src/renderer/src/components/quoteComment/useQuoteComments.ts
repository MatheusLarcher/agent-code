/**
 * O estado do "Comentar" de um chat: os trechos que estão no campo de mensagem
 * (anexos inline, "[trecho N]" — quem os guarda é o Composer, ver
 * useComposerQuotes) e os trechos já comentados (tirados das mensagens do usuário).
 *
 * Mora no ChatPanel — o mesmo painel do chat principal e do chat do
 * planejamento (montado dentro do ManagerChatFloat) —, não no App.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import type { UIMessage } from '../../types'
import { useUI } from '../../ui/UiProvider'
import { clipQuote, indexCommented, quoteMatchesBlock, type Quote } from './quoteFormat'
import type { QuoteListApi, QuoteMark } from './quoteBlocks'
import type { ComposerQuoteLink, QuoteInserter } from './useComposerQuotes'

export type SendFn = (
  text: string,
  images: ImageAttachment[],
  files: FileAttachment[],
  fileRefs: FileRefAttachment[]
) => void

export interface QuoteComments {
  /** Os trechos no campo de mensagem agora, na ordem do texto. */
  pending: Quote[]
  /** Para o MessageList: marcar blocos e comentar um. */
  list: QuoteListApi
  /** Para o Composer (prop `quoteLink`). */
  link: ComposerQuoteLink
}

export function useQuoteComments(messages: readonly UIMessage[]): QuoteComments {
  const { notify } = useUI()
  const [pending, setPending] = useState<Quote[]>([])
  const inserterRef = useRef<QuoteInserter | null>(null)
  const link = useMemo<ComposerQuoteLink>(() => ({ inserterRef, onChange: setPending }), [])

  const commented = useMemo(() => indexCommented(messages), [messages])

  const add = useCallback(
    (messageId: string, blockText: string) => {
      const text = clipQuote(blockText)
      if (!text) return
      const result = inserterRef.current?.insert({ messageId, text }) ?? 'locked'
      if (result === 'dup') notify('aviso', 'Esse trecho já está citado no campo de mensagem.')
      else if (result === 'locked') notify('aviso', 'O campo de mensagem está travado: não dá para citar o trecho agora.')
    },
    [notify]
  )

  const markOf = useCallback(
    (messageId: string, blockText: string): QuoteMark => {
      const hit = (q: Quote): boolean => q.messageId === messageId && quoteMatchesBlock(q.text, blockText)
      if (pending.some(hit)) return 'pending'
      return commented.get(messageId)?.some(hit) ? 'commented' : null
    },
    [pending, commented]
  )

  const list = useMemo<QuoteListApi>(() => ({ markOf, add }), [markOf, add])

  return { pending, list, link }
}
