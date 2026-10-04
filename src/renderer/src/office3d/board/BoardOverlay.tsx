/**
 * A janela do kanban do Escritório 3D, no padrão do telão do projetor (fundo
 * escurecido; Esc — na captura, nem a tela do monitor nem o chat recebem — ou
 * clique fora fecha):
 *
 *   card  o cartão grande: o MESMO detalhe da aba Quadro (BoardCardDetail), com
 *         a linha do tempo; acompanha a revisão e fecha se o cartão sai do quadro.
 *         Aberto por clique no papel, ele "voa" do ponto do clique até o centro.
 *   pile  a lista da coluna (a pilha "+K"): todos os cartões dela, na ordem do
 *         Quadro; clicar num abre o cartão grande.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { boardItemAwaitingBadge, type BoardItem } from '@shared/ipc'
import { BoardCardDetail } from '../../components/BoardCardDetail'
import type { BoardOpen } from '../engineTypes'
import { columnLabel } from './boardModel'
import type { EngineBoard } from './engineBoard'
import './board3d.css'

export interface BoardOverlayProps {
  open: BoardOpen
  board: EngineBoard
  onClose: () => void
  /** Troca o que a janela mostra (da lista para o cartão). */
  onOpen: (open: BoardOpen) => void
  onOpenConversation: (convId: string) => void
}

const CLOCK_TICK_MS = 30_000

export function BoardOverlay({ open, board, onClose, onOpen, onOpenConversation }: BoardOverlayProps): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())
  const item: BoardItem | undefined = open.kind === 'card' ? board.sync.item(open.id) : undefined
  const gone = open.kind === 'card' && !item

  // Esc fecha só a janela (fase de captura).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])

  // O cartão saiu do quadro (dispensado, o agente refez o plano): a janela fecha.
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])

  // O papel "voa" do ponto do clique até o centro.
  useLayoutEffect(() => {
    const el = rootRef.current?.firstElementChild as HTMLElement | null
    const root = rootRef.current
    if (!el || !root || open.x === null || open.y === null) return
    const r = root.getBoundingClientRect()
    el.style.setProperty('--fly-x', `${open.x - (r.left + r.width / 2)}px`)
    el.style.setProperty('--fly-y', `${open.y - (r.top + r.height / 2)}px`)
    el.classList.add('fly')
  }, [open])

  if (gone) return null
  const label = open.kind === 'card' ? 'Cartão do quadro' : `Coluna ${columnLabel(open.status)}`
  return (
    <div
      ref={rootRef}
      className="o3d-board-overlay"
      role="dialog"
      aria-label={label}
      data-testid="o3d-board-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {item ? (
        <div className="o3d-board-card" key={item.id}>
          <BoardCardDetail
            item={item}
            conversationTitles={{ [item.conversationId]: board.title(item.conversationId) ?? 'Conversa removida' }}
            now={now}
            onClose={onClose}
            onOpenConversation={(convId) => {
              onClose()
              onOpenConversation(convId)
            }}
            onDismiss={(it) => {
              void board.sync.dismiss(it.id, !it.dismissedAt).finally(onClose)
            }}
            loadEvents={(id) => board.sync.events(id)}
          />
        </div>
      ) : open.kind === 'pile' ? (
        <PileList open={open} board={board} onClose={onClose} onOpen={onOpen} />
      ) : null}
    </div>
  )
}

/** O selo "Aguardando você"/"Interrompido" — o mesmo texto da aba Quadro (`boardItemAwaitingBadge`). */
function AwaitingTag({ item }: { item: BoardItem | undefined }): JSX.Element | null {
  const badge = item ? boardItemAwaitingBadge(item) : null
  return badge ? <span className={`board-tag awaiting ${badge.kind}`}>{badge.label}</span> : null
}

function PileList({ open, board, onClose, onOpen }: { open: Extract<BoardOpen, { kind: 'pile' }>; board: EngineBoard; onClose: () => void; onOpen: (o: BoardOpen) => void }): JSX.Element {
  const cards = board.sync.mirror(open.roomId)?.shown.filter((c) => c.status === open.status) ?? []
  return (
    <div className="o3d-board-card o3d-board-list">
      <header className="board-detail-head">
        <h3>
          {columnLabel(open.status)} <span className="board-muted">· {cards.length} cartões</span>
        </h3>
        <button type="button" className="nav-btn" onClick={onClose} title="Fechar (Esc)">
          ×
        </button>
      </header>
      {cards.length === 0 ? (
        <p className="board-muted">Nenhum cartão nesta coluna agora.</p>
      ) : (
        <ul className="o3d-board-rows">
          {cards.map((c) => (
            <li key={c.id}>
              <button type="button" className="board-row" onClick={() => onOpen({ kind: 'card', id: c.id, x: null, y: null })}>
                <span className={`board-check ${c.status}`} aria-hidden="true">
                  {c.status === 'completed' ? '✓' : ''}
                </span>
                <span className={`board-row-title ${c.status}`}>{c.title}</span>
                {c.awaiting && <AwaitingTag item={board.sync.item(c.id)} />}
                {c.origin === 'po' && <span className="board-tag po">PO</span>}
                <span className="board-row-when">{board.title(c.conversationId) ?? 'Conversa removida'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
