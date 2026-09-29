/**
 * O estado do "Comentar" de um chat: os chips "↳ trecho" pendentes no campo de
 * mensagem e os trechos já comentados (tirados das mensagens do usuário).
 *
 * Mora no ChatPanel — o mesmo painel do chat principal e do chat do
 * planejamento (montado dentro do ManagerChatFloat) —, não no App: os chips são
 * da conversa aberta e somem ao trocar de conversa e depois do envio.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import type { UIMessage } from '../../types'
import { useUI } from '../../ui/UiProvider'
import { buildQuotedMessage, clipQuote, indexCommented, quoteMatchesBlock, type Quote } from './quoteFormat'
import type { QuoteListApi, QuoteMark } from './quoteBlocks'

/** Um chip pendente: o trecho (já cortado no teto) e uma chave para o React/remoção. */
export interface QuoteChip extends Quote {
  key: string
}

export type SendFn = (
  text: string,
  images: ImageAttachment[],
  files: FileAttachment[],
  fileRefs: FileRefAttachment[]
) => void

export interface QuoteComments {
  chips: QuoteChip[]
  remove: (key: string) => void
  /** Para o MessageList: marcar blocos e comentar um. */
  list: QuoteListApi
  /** Embrulha o envio: os trechos vão na frente do texto e os chips somem. */
  wrapSend: (send: SendFn) => SendFn
}

export function useQuoteComments(
  convId: string | null,
  messages: readonly UIMessage[],
  /** Depois de pôr um chip (o ChatPanel leva o foco para o campo de mensagem). */
  onAdded?: () => void
): QuoteComments {
  const { notify } = useUI()
  const [chips, setChips] = useState<QuoteChip[]>([])
  // Trocou de conversa: os chips eram da anterior. Ajuste no próprio render
  // (como a janela do MessageList), então a conversa nova já abre sem eles.
  const [owner, setOwner] = useState(convId)
  if (owner !== convId) {
    setOwner(convId)
    setChips([])
  }
  // A lista mais recente para quem roda fora do render (clique, envio): dois
  // cliques antes do próximo render já enxergam o primeiro chip.
  const chipsRef = useRef(chips)
  chipsRef.current = chips
  const onAddedRef = useRef(onAdded)
  onAddedRef.current = onAdded
  const seq = useRef(0)

  const commented = useMemo(() => indexCommented(messages), [messages])

  const add = useCallback(
    (messageId: string, blockText: string) => {
      const text = clipQuote(blockText)
      if (!text) return
      if (chipsRef.current.some((c) => c.messageId === messageId && c.text === text)) {
        notify('aviso', 'Esse trecho já está citado no campo de mensagem.')
        return
      }
      const chip = { key: `${messageId}#${++seq.current}`, messageId, text }
      chipsRef.current = [...chipsRef.current, chip]
      setChips(chipsRef.current)
      onAddedRef.current?.()
    },
    [notify]
  )

  const remove = useCallback((key: string) => {
    chipsRef.current = chipsRef.current.filter((c) => c.key !== key)
    setChips(chipsRef.current)
  }, [])

  const markOf = useCallback(
    (messageId: string, blockText: string): QuoteMark => {
      const hit = (q: Quote): boolean => q.messageId === messageId && quoteMatchesBlock(q.text, blockText)
      if (chips.some(hit)) return 'pending'
      return commented.get(messageId)?.some(hit) ? 'commented' : null
    },
    [chips, commented]
  )

  const list = useMemo<QuoteListApi>(() => ({ markOf, add }), [markOf, add])

  const wrapSend = useCallback(
    (send: SendFn): SendFn =>
      (text, images, files, fileRefs) => {
        const quotes = chipsRef.current
        send(buildQuotedMessage(quotes, text), images, files, fileRefs)
        if (quotes.length) {
          chipsRef.current = []
          setChips([])
        }
      },
    []
  )

  return { chips, remove, list, wrapSend }
}
