import { useEffect, useRef, useState } from 'react'
import {
  boardItemStatus as effectiveStatus,
  boardItemTitle as effectiveTitle,
  isBoardItemPoCorrected as isPoCorrected,
  type BoardItem,
  type BoardItemEvent,
  type BoardItemStatus
} from '@shared/ipc'
import { IconSpinner } from './Icons'
import { CardPrints } from './BoardPrints'
import { ReadRetry } from './ReadRetry'

/**
 * O detalhe de um cartão do Quadro — o MESMO no painel (BoardPanel) e na janela
 * do cartão do Escritório 3D (office3d/board/BoardOverlay): título, status,
 * conversa (link), título original, observação, o que você precisa fazer,
 * motivo atual, datas, quem criou, revisão, a linha do tempo (quem fez o quê e
 * por quê) e as ações abrir a conversa e dispensar/restaurar. A linha do tempo é
 * lida sob demanda e acompanha a revisão do cartão (o motivo novo aparece sem
 * reabrir).
 */

export const COLUMNS: { status: BoardItemStatus; label: string; key: string }[] = [
  { status: 'pending', label: 'A fazer', key: 'todo' },
  { status: 'in_progress', label: 'Fazendo', key: 'doing' },
  { status: 'completed', label: 'Concluído', key: 'done' }
]

export function fmtAgo(iso: string | null, now: number): string {
  if (!iso) return ''
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'agora'
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'agora'
  const m = Math.floor(s / 60)
  if (m < 60) return `há ${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `há ${h} h`
  return `há ${Math.floor(h / 24)} d`
}

/** Data e hora completas — o par do `fmtAgo` relativo: útil quando "há 3 h"
 *  não basta e a pessoa quer saber exatamente quando. */
function fmtWhen(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return new Date(ms).toLocaleString('pt-BR')
}

const EVENT_LABEL: Record<BoardItemEvent['kind'], string> = {
  created: 'criou o cartão',
  status_changed: 'mudou o status',
  retitled: 'reescreveu o título',
  note_changed: 'mudou a observação',
  dismissed: 'dispensou o cartão',
  restored: 'restaurou o cartão',
  justified: 'justificou'
}

/** Quem aparece na linha do tempo. `system` é regra automática do app — não o PO. */
const ACTOR_LABEL: Record<BoardItemEvent['actor'], string> = {
  po: 'PO',
  user: 'Você',
  agent: 'Agente',
  system: 'Sistema'
}

function statusLabel(status: BoardItemStatus | null): string {
  if (!status) return ''
  return COLUMNS.find((c) => c.status === status)?.label ?? status
}

function EventLine({ event, now }: { event: BoardItemEvent; now: number }): JSX.Element {
  let text = EVENT_LABEL[event.kind]
  if (event.kind === 'status_changed' && event.toStatus) {
    text = `mudou para ${statusLabel(event.toStatus).toLowerCase()}`
  }
  return (
    <li className="board-timeline-row">
      <span className={`board-who ${event.actor}`}>{ACTOR_LABEL[event.actor] ?? 'Agente'}</span>
      <span className="board-timeline-text">
        {text}
        {event.note && <span className="board-muted"> — {event.note}</span>}
      </span>
      <span className="board-timeline-when" title={fmtWhen(event.at)}>
        {fmtAgo(event.at, now)}
      </span>
    </li>
  )
}

export interface BoardCardDetailProps {
  item: BoardItem
  conversationTitles: Record<string, string>
  now: number
  onClose: () => void
  onOpenConversation: (convId: string) => void
  onDismiss: (item: BoardItem) => void
  /** De onde vem a linha do tempo (padrão: o Quadro do app). O 3D passa a fonte do quadro da sala. */
  loadEvents?: (boardItemId: string) => Promise<BoardItemEvent[]>
  /** Acha outro cartão do quadro pelo id — o pai da pendência ("Pendência de"). */
  findItem?: (id: string) => BoardItem | undefined
  /** Abre outro cartão no lugar deste (o clique no pai da pendência). */
  onOpenItem?: (item: BoardItem) => void
}

const appEvents = (id: string): Promise<BoardItemEvent[]> => window.api.boardItemEvents(id)

export function BoardCardDetail({
  item,
  conversationTitles,
  now,
  onClose,
  onOpenConversation,
  onDismiss,
  loadEvents = appEvents,
  findItem,
  onOpenItem
}: BoardCardDetailProps): JSX.Element {
  const status = effectiveStatus(item)
  const parent = item.parentId ? findItem?.(item.parentId) : undefined
  const [events, setEvents] = useState<BoardItemEvent[]>([])
  const [loadingEvents, setLoadingEvents] = useState(false)
  // Falha ou prazo estourado não vira "sem histórico": vira "tentar de novo".
  const [eventsError, setEventsError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  // Busca preguiçosa por cartão: só quando o detalhe abre, de novo se o usuário
  // clicar noutro cartão e quando a revisão sobe (o cartão mudou com ele
  // aberto) — nunca em loop, e nunca para o quadro inteiro que ninguém abriu.
  const fetchedFor = useRef<string | null>(null)
  const shownFor = useRef<string | null>(null)

  useEffect(() => {
    const key = `${item.id}@${item.revision}#${attempt}`
    if (fetchedFor.current === key) return
    fetchedFor.current = key
    let alive = true
    // Outro cartão: o histórico anterior não vale; o mesmo com revisão nova: troca sem piscar.
    const fresh = shownFor.current !== item.id
    shownFor.current = item.id
    if (fresh) {
      setEvents([])
      setLoadingEvents(true)
    }
    setEventsError(null)
    void loadEvents(item.id)
      .then((result) => {
        if (alive) setEvents(result)
      })
      .catch((error: unknown) => {
        if (alive) setEventsError(error)
      })
      .finally(() => {
        if (alive) setLoadingEvents(false)
      })
    return () => {
      alive = false
    }
    // A fonte é fixa por janela; só o cartão, a revisão e o "tentar de novo" pedem nova leitura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, item.revision, attempt])

  return (
    <div className="board-detail">
      <header className="board-detail-head">
        <h3>{effectiveTitle(item)}</h3>
        <button type="button" className="nav-btn" onClick={onClose} title="Fechar">
          ×
        </button>
      </header>
      <dl className="board-detail-kv">
        <dt>Status</dt>
        <dd className={`board-status ${status}`}>{statusLabel(status)}</dd>
        <dt>Origem</dt>
        <dd>
          <button type="button" className="board-link" onClick={() => onOpenConversation(item.conversationId)}>
            {conversationTitles[item.conversationId] ?? 'Conversa removida'}
          </button>
        </dd>
        {/* A pendência (commitar, verificar, deploy) diz de qual pedido sobrou. */}
        {item.parentId && (
          <>
            <dt>Pendência de</dt>
            <dd>
              {parent ? (
                <button
                  type="button"
                  className="board-link"
                  onClick={() => onOpenItem?.(parent)}
                  disabled={!onOpenItem}
                  title="Abrir o cartão de origem"
                >
                  {effectiveTitle(parent)}
                </button>
              ) : (
                <span className="board-muted">um cartão que não está mais no quadro</span>
              )}
            </dd>
          </>
        )}
        {item.poTitle && (
          <>
            <dt>Título do agente</dt>
            <dd className="board-muted">{item.sourceTitle}</dd>
          </>
        )}
        {item.poNote && (
          <>
            <dt>Observação</dt>
            <dd>{item.poNote}</dd>
          </>
        )}
      </dl>
      {/* O que destrava o cartão parado esperando o usuário, ANTES do motivo: é a
          primeira coisa que ele precisa ler. Só enquanto está "a fazer" — o campo
          some quando o status do PO é substituído. */}
      {item.poUserAction && status === 'pending' && (
        <div className="board-detail-action" aria-label="O que você precisa fazer">
          <span className="board-who">O que você precisa fazer</span>
          <span>{item.poUserAction}</span>
        </div>
      )}
      {/* A trilha do PO é o que torna a correção automática auditável: sem o
          motivo na tela, um PO errado vira um quadro errado sem explicação. */}
      {/* "Motivo atual", não "PO": o motivo também pode ser de uma regra
          automática (fim de turno, retomada) ou do arrasto do usuário — quem
          escreveu cada um está na linha do tempo. */}
      {item.poReason && (
        <div className="board-detail-trail" aria-label="Motivo atual">
          <span className="board-who">Motivo atual</span>
          <span>
            {isPoCorrected(item) ? `marcou como ${statusLabel(item.poStatus).toLowerCase()}: ${item.poReason}` : item.poReason}
          </span>
        </div>
      )}

      {/* O print da tarefa visual que o agente testou (app_anexar_print). */}
      <CardPrints boardItemId={item.id} />

      <div className="board-detail-meta">
        <div className="board-detail-meta-row">
          <span>Criado</span>
          <span title={fmtWhen(item.createdAt)}>{fmtWhen(item.createdAt)}</span>
        </div>
        <div className="board-detail-meta-row">
          <span>Atualizado</span>
          <span title={fmtWhen(item.updatedAt)}>{fmtWhen(item.updatedAt)}</span>
        </div>
        <div className="board-detail-meta-row">
          <span>Quem criou</span>
          <span>{item.origin === 'po' ? 'PO' : 'Agente'}</span>
        </div>
        <div className="board-detail-meta-row">
          <span>Revisão</span>
          <span>{item.revision}</span>
        </div>
      </div>

      <div className="board-detail-timeline">
        <div className="board-detail-timeline-title">Linha do tempo</div>
        {loadingEvents ? (
          <p className="board-empty">
            <IconSpinner className="spinner" size={13} /> Carregando o histórico…
          </p>
        ) : eventsError && events.length === 0 ? (
          <ReadRetry error={eventsError} what="o histórico" onRetry={() => setAttempt((n) => n + 1)} />
        ) : events.length === 0 ? (
          <p className="board-muted">Sem histórico registrado ainda.</p>
        ) : (
          <ul className="board-timeline">
            {events.map((event) => (
              <EventLine key={event.id} event={event} now={now} />
            ))}
          </ul>
        )}
      </div>

      <div className="board-detail-actions">
        <button type="button" className="board-dismiss" onClick={() => onDismiss(item)}>
          {item.dismissedAt ? 'Restaurar cartão' : 'Dispensar cartão'}
        </button>
      </div>
    </div>
  )
}
