/**
 * Os painéis laterais que um foco do escritório abre: a estante de Memórias
 * (MEMORY_SHELF_KEY) e o Diário do Scrum Master (SCRUM_PANEL_KEY). O do SM lê
 * os dados só enquanto está aberto (useScrumPanel) e pinta cada projeto na cor
 * dele no escritório.
 */
import type { OfficeFeed } from '../../office/adapter/feed'
import type { Office3DEngine } from '../engine'
import { MEMORY_SHELF_KEY } from '../engineTypes'
import { OfficeMemoryPanel } from '../OfficeMemoryPanel'
import { agentCss } from '../projectColor'
import { ScrumPanel } from './ScrumPanel'
import { SCRUM_PANEL_KEY } from './scrumFocus'
import { useScrumPanel } from './useScrumPanel'

interface PanelProps {
  feed: OfficeFeed | null
  onClose: () => void
  /** Mostra a conversa no chat flutuante (o painel fecha antes, para ele voltar). */
  onOpenConversation: (convId: string) => void
  /** O 📍: voa até a mesa do agente da conversa. */
  onLocate: (convId: string) => void
  onSend?: (convId: string, text: string) => void
}

export function OfficeScrumPanel({ feed, onClose, onOpenConversation, onLocate, onSend }: PanelProps): JSX.Element {
  const data = useScrumPanel()
  return (
    <ScrumPanel
      data={data}
      colorOf={(cwd) => agentCss(feed, cwd, `scrum:${cwd ?? ''}`)}
      onClose={onClose}
      onLocate={onLocate}
      onOpenConversation={(convId) => {
        onClose()
        onOpenConversation(convId)
      }}
      onSend={onSend}
    />
  )
}

/** A estante de Memórias e o Scrum Master: o foco neles abre o painel lateral, que dura enquanto ele durar. */
export function OfficeFocusPanel({ focusKey, engine, ...rest }: PanelProps & { focusKey: string | null; engine: Office3DEngine }): JSX.Element | null {
  // O clique na estante de Memórias é um foco nela: o painel (só leitura) dura enquanto ele durar.
  if (focusKey === MEMORY_SHELF_KEY) return <OfficeMemoryPanel engine={engine} feed={rest.feed} onClose={rest.onClose} onOpenConversation={rest.onOpenConversation} />
  if (focusKey === SCRUM_PANEL_KEY) return <OfficeScrumPanel {...rest} />
  return null
}
