/**
 * O painel de Memórias no Escritório: os dados (useMemoryPanel, só com ele
 * aberto) e quem está na estante agora, lido da turma do motor.
 */
import { CENTRAL_ID } from '@shared/central'
import type { OfficeFeed } from '../office/adapter/feed'
import { principalKey } from '../office/adapter/model'
import type { Office3DEngine } from './engine'
import { MemoryPanel } from './MemoryPanel'
import { agentCss } from './projectColor'
import { useMemoryPanel } from './useMemoryPanel'

export interface OfficeMemoryPanelProps {
  engine: Office3DEngine
  feed: OfficeFeed | null
  onClose: () => void
  onOpenConversation: (convId: string) => void
}

/** Quem está na estante agora: consultando a memória (modo 'archive') ou o papel memória, já lá. */
export function atShelf(engine: Pick<Office3DEngine, 'scene'>, feed: OfficeFeed | null): Array<{ convId: string; name: string }> {
  const title = new Map((feed?.conversations ?? []).map((c) => [c.id, c.title]))
  const out = new Map<string, string>()
  for (const b of engine.scene.crowd.list) {
    if (!b.visible || !b.arrived || !(b.mode === 'archive' || (b.mode === 'fixed' && b.style === 'archive'))) continue
    const convId = engine.scene.character(b.key)?.model.convId
    if (convId) out.set(convId, title.get(convId) || 'Agente')
  }
  return [...out].map(([convId, name]) => ({ convId, name }))
}

export function OfficeMemoryPanel({ engine, feed, onClose, onOpenConversation }: OfficeMemoryPanelProps): JSX.Element {
  const data = useMemoryPanel(true, feed?.conversations ?? [])
  return (
    <MemoryPanel
      data={data}
      atShelf={atShelf(engine, feed)}
      onClose={onClose}
      onFlyToAgent={(convId) => engine.flyToAgent(`conv:${convId}`)}
      onOpenConversation={onOpenConversation}
      dotOf={(e) => agentCss(feed, e.convId === CENTRAL_ID ? null : e.project || null, principalKey(e.convId))}
    />
  )
}
