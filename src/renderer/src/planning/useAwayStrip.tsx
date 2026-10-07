import { useCallback } from 'react'
import { AwaySummaryStrip } from './AwaySummaryStrip'
import type { AwayEntry } from './awaySummary'
import { awayAnnouncementId, useAwayOffice } from './useAwayOffice'
import { useAwaySummaries } from './useAwaySummary'

/**
 * O resumo "desde que você saiu" ligado ao App numa peça só: o projeto à vista
 * (a conversa ativa, com o quadro ao lado), a faixa do topo do quadro e da
 * conversa, o clique que leva ao cartão e o PO no escritório.
 */
export function useAwayStrip(opts: {
  projectCwd: string | null
  /** Abre o cartão no painel do Quadro (components/boardOpenCard.ts). */
  openCard(cardId: string, conversationId: string): void
  openConversation(convId: string): void
  /** A leitura em voz alta do App (o mesmo tocador das respostas). */
  speak(id: string, text: string): void
}): {
  strip(inChat: boolean): JSX.Element
} {
  const away = useAwaySummaries(opts.projectCwd)
  useAwayOffice(away.all, opts.speak)
  const { openCard, openConversation } = opts

  const onOpen = useCallback(
    (entry: AwayEntry): void => {
      if (!entry.cardId) return openConversation(entry.conversationId)
      openCard(entry.cardId, entry.conversationId)
    },
    [openCard, openConversation]
  )

  const current = away.current
  const strip = (inChat: boolean): JSX.Element => (
    <AwaySummaryStrip
      key={current ? awayAnnouncementId(current) : 'nenhum'}
      summary={current}
      onOpen={onOpen}
      onDismiss={away.dismiss}
      inChat={inChat}
    />
  )
  return { strip }
}
