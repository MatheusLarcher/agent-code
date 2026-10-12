/**
 * A folha de um cartão do Quadro: o MESMO detalhe do PC (BoardCardDetail —
 * status, conversa, motivo, prints, linha do tempo, arquivar/restaurar) e, no
 * rodapé, "Mover para…" por botões (o celular não arrasta).
 */
import { useMemo } from 'react'
import { boardItemStatus, type BoardItem, type BoardItemStatus } from '@shared/ipc'
import { BoardCardDetail, COLUMNS } from '@renderer/components/BoardCardDetail'
import { client } from '../app/runtime'
import { useStore } from '../core/store'

interface Props {
  item: BoardItem
  items: BoardItem[]
  moving: boolean
  onClose: () => void
  onMove: (item: BoardItem, to: BoardItemStatus) => void
  onDismiss: (item: BoardItem) => void
  onOpenConversation: (convId: string) => void
  onOpenItem: (item: BoardItem) => void
}

export function BoardSheet({ item, items, moving, onClose, onMove, onDismiss, onOpenConversation, onOpenItem }: Props): JSX.Element {
  const conversations = useStore(client.store, (s) => s.conversations)
  const titles = useMemo(() => Object.fromEntries(conversations.map((c) => [c.id, c.title || 'Conversa sem título'])), [conversations])
  const status = boardItemStatus(item)
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card pl-sheet bd-sheet" role="dialog" aria-label="Cartão do quadro" onClick={(e) => e.stopPropagation()}>
        <div className="pl-sheet-body">
          <BoardCardDetail
            item={item}
            conversationTitles={titles}
            now={Date.now()}
            onClose={onClose}
            onOpenConversation={onOpenConversation}
            onDismiss={onDismiss}
            findItem={(id) => items.find((it) => it.id === id)}
            onOpenItem={onOpenItem}
          />
        </div>
        <div className="pl-sheet-actions bd-move">
          <span className="pl-sheet-label">Mover para…</span>
          <div className="bd-move-btns">
            {COLUMNS.filter((c) => c.status !== status).map((c) => (
              <button key={c.status} type="button" className={`btn ghost bd-move-btn ${c.key}`} disabled={moving} onClick={() => onMove(item, c.status)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
