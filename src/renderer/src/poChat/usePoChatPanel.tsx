import { useCallback, useEffect, useRef, useState } from 'react'
import { boardItemTitle, type BoardItem } from '@shared/ipc'
import { PoChatPanel } from './PoChatPanel'
import { usePoChat } from './usePoChat'

/**
 * O "Fala, PO" ligado ao App: abre pelo botão do quadro (no lugar do chat
 * principal, como a Central, com o quadro ao lado), fecha no "Voltar" ou
 * quando outra conversa vira a ativa (o chat principal volta a ser ela), e
 * acompanha o cartão selecionado no quadro (o chip "Como está '<card>'?").
 */
export function usePoChatPanel(opts: {
  projectCwd: string | null
  activeId: string | null
  openCard(cardId: string, conversationId: string): void
  openConversation(convId: string): void
  /** A conversa existe neste PC, nesta pasta? (sem ela, o "Mandar fazer" usa uma nova) */
  isLocalConversation?(conversationId: string, projectCwd: string): boolean
  /** Cria a conversa nova de implementação (ao fundo, sem trocar a ativa). */
  createConversation?(projectCwd: string, title: string): { id: string; title: string } | null
  /** "Ver na fila": o painel do quadro com a faixa "Próximos prompts". */
  showQueue?(): void
}): {
  isOpen: boolean
  open(): void
  close(): void
  panel: JSX.Element | null
  onBoardSelect(item: BoardItem | null): void
} {
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ id: string; title: string } | null>(null)
  const state = usePoChat(openFor)
  const { projectCwd, openCard, openConversation } = opts

  const lastActive = useRef(opts.activeId)
  useEffect(() => {
    if (lastActive.current === opts.activeId) return
    lastActive.current = opts.activeId
    setOpenFor(null)
  }, [opts.activeId])

  const open = useCallback((): void => {
    if (projectCwd) setOpenFor(projectCwd)
  }, [projectCwd])
  const close = useCallback((): void => setOpenFor(null), [])
  const onBoardSelect = useCallback((item: BoardItem | null): void => {
    setSelected(item ? { id: item.id, title: boardItemTitle(item) } : null)
  }, [])

  const panel = openFor ? (
    <PoChatPanel
      projectCwd={openFor}
      projectName={openFor.split(/[\\/]/).filter(Boolean).pop() ?? openFor}
      state={state}
      selectedCard={selected}
      onBack={close}
      onOpenConversation={(convId) => {
        setOpenFor(null)
        openConversation(convId)
      }}
      onOpenCard={openCard}
      isLocalConversation={opts.isLocalConversation ? (id) => opts.isLocalConversation!(id, openFor) : undefined}
      createConversation={opts.createConversation ? (title) => opts.createConversation!(openFor, title) : undefined}
      onShowQueue={opts.showQueue}
    />
  ) : null

  return { isOpen: openFor !== null, open, close, panel, onBoardSelect }
}
