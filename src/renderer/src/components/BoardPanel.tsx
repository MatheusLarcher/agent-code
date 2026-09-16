import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  boardItemStatus as effectiveStatus,
  boardItemTitle as effectiveTitle,
  isBoardItemPoCorrected as isPoCorrected,
  type BoardItem,
  type BoardItemStatus
} from '@shared/ipc'
import { IconCollapseRight, IconSpinner } from './Icons'

/**
 * O quadro de tarefas do projeto: o que o agente declarou que ia fazer, e o que
 * ele já concluiu — marcado sozinho, sem ninguém arrastar cartão.
 *
 * É **somente leitura**, com uma exceção deliberada (arquivar um cartão). Quem
 * move o estado é o agente (pelo snapshot do CLI) e o PO; um terceiro dono do
 * mesmo estado só criaria conflito — a mesma razão pela qual o painel do
 * registro de tarefas também não move nada.
 */

const COLUMNS: { status: BoardItemStatus; label: string; key: string }[] = [
  { status: 'pending', label: 'A fazer', key: 'todo' },
  { status: 'in_progress', label: 'Fazendo', key: 'doing' },
  { status: 'completed', label: 'Concluído', key: 'done' }
]

/** Recarrega rápido enquanto o agente trabalha, devagar quando está parado —
 *  o mesmo critério do `TasksBoard`. O evento `board:changed` cobre o resto. */
const POLL_BUSY_MS = 5_000
const POLL_IDLE_MS = 30_000
/** O texto de tempo muda de minuto em minuto; não há por que tiquetaquear mais. */
const CLOCK_TICK_MS = 30_000

interface Props {
  projectCwd: string
  /** Conversa ativa — o recorte padrão do quadro. */
  conversationId: string
  /** id → título, para agrupar e nomear a origem de cada cartão. */
  conversationTitles: Record<string, string>
  busy: boolean
  onClose: () => void
  onOpenConversation: (convId: string) => void
  /** Reporta o progresso para o rótulo da aba — assim o App não precisa fazer
   *  a MESMA consulta em paralelo enquanto o painel está aberto. */
  onProgress?: (progress: { done: number; total: number } | null) => void
  width?: number
}

/** Reexportados para quem já importava daqui; a regra mora em `@shared/ipc`,
 *  porque é a MESMA que o main usa para ordenar o quadro. */
export { effectiveStatus, effectiveTitle, isPoCorrected }

/** Concluídas de um grupo. Uma passada só — a contagem é usada duas vezes na
 *  mesma linha (o número e o plural). */
function groupDone(list: BoardItem[]): number {
  return list.filter((entry) => effectiveStatus(entry) === 'completed').length
}

function fmtAgo(iso: string | null, now: number): string {
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

/**
 * O PO escreveu um status neste cartão e o agente, no fim, disse a mesma coisa.
 *
 * Acontece de verdade quando o PO abre o cartão em andamento e a reabertura de
 * fim de turno o devolve para "a fazer", que é onde o snapshot do agente já
 * estava: `isPoCorrected` fica `false` — e fica certo, porque ninguém está
 * discordando de ninguém — mas o cartão TEM uma trilha do PO para ler. Sem este
 * caso, o mesmo cartão apareceria marcado na Lista (que olha `poStatus`) e
 * limpo no Quadro, e o usuário não teria motivo para clicar e descobrir por que
 * o trabalho voltou para a primeira coluna.
 */
function poAgreed(item: BoardItem): boolean {
  return item.poStatus !== null && !isPoCorrected(item) && item.origin === 'agent' && !item.poTitle
}

function Card({
  item,
  now,
  onOpen
}: {
  item: BoardItem
  now: number
  onOpen: (item: BoardItem) => void
}): JSX.Element {
  const status = effectiveStatus(item)
  return (
    <button type="button" className={`board-card ${status}`} onClick={() => onOpen(item)}>
      <span className="board-card-top">
        <span className={`board-check ${status}`} aria-hidden="true">
          {status === 'completed' ? '✓' : ''}
        </span>
        <span className="board-card-title">{effectiveTitle(item)}</span>
      </span>
      {status === 'in_progress' && item.activeForm && (
        <span className="board-card-detail">{item.activeForm}</span>
      )}
      <span className="board-card-tags">
        {item.origin === 'po' && <span className="board-tag po">PO acrescentou</span>}
        {isPoCorrected(item) && <span className="board-tag po">PO corrigiu</span>}
        {item.poTitle && item.origin === 'agent' && !isPoCorrected(item) && (
          <span className="board-tag po">PO reescreveu</span>
        )}
        {poAgreed(item) && <span className="board-tag po">PO revisou</span>}
        {status === 'completed' && <span className="board-tag auto">{fmtAgo(item.updatedAt, now)}</span>}
      </span>
    </button>
  )
}

function Detail({
  item,
  conversationTitles,
  onClose,
  onOpenConversation,
  onDismiss
}: {
  item: BoardItem
  conversationTitles: Record<string, string>
  onClose: () => void
  onOpenConversation: (convId: string) => void
  onDismiss: (item: BoardItem) => void
}): JSX.Element {
  const status = effectiveStatus(item)
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
        <dd className={`board-status ${status}`}>
          {COLUMNS.find((c) => c.status === status)?.label ?? status}
        </dd>
        <dt>Origem</dt>
        <dd>
          <button type="button" className="board-link" onClick={() => onOpenConversation(item.conversationId)}>
            {conversationTitles[item.conversationId] ?? 'Conversa removida'}
          </button>
        </dd>
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
      {/* A trilha do PO é o que torna a correção automática auditável: sem o
          motivo na tela, um PO errado vira um quadro errado sem explicação. */}
      {item.poReason && (
        <div className="board-detail-trail">
          <span className="board-who po">PO</span>
          <span>
            {isPoCorrected(item)
              ? `marcou como ${COLUMNS.find((c) => c.status === item.poStatus)?.label.toLowerCase()}: ${item.poReason}`
              : item.poReason}
          </span>
        </div>
      )}
      <div className="board-detail-actions">
        <button type="button" className="board-dismiss" onClick={() => onDismiss(item)}>
          {item.dismissedAt ? 'Restaurar cartão' : 'Dispensar cartão'}
        </button>
      </div>
    </div>
  )
}

export function BoardPanel({
  projectCwd,
  conversationId,
  conversationTitles,
  busy,
  onClose,
  onOpenConversation,
  onProgress,
  width
}: Props): JSX.Element {
  const [items, setItems] = useState<BoardItem[]>([])
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'board' | 'list'>('board')
  const [wholeProject, setWholeProject] = useState(false)
  const [selected, setSelected] = useState<BoardItem | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    if (!projectCwd) {
      setItems([])
      setLoading(false)
      return
    }
    const board = await window.api.boardList({
      projectCwd,
      conversationId: wholeProject ? undefined : conversationId
    })
    setAvailable(board.available)
    setItems(board.items)
    setLoading(false)
  }, [projectCwd, conversationId, wholeProject])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  // O evento é o caminho rápido; o poll é a rede de segurança para o caso de
  // a mudança ter vindo de OUTRO PC (change feed do PostgreSQL).
  useEffect(() => window.api.onBoardChanged(() => void load()), [load])

  useEffect(() => {
    const id = setInterval(() => void load(), busy ? POLL_BUSY_MS : POLL_IDLE_MS)
    return () => clearInterval(id)
  }, [busy, load])

  // Relógio separado do poll, e lento: `fmtAgo` tem granularidade de minuto,
  // então tiquetaquear junto com a recarga repintaria o painel inteiro 12 vezes
  // por minuto sem mudar um pixel (mesmo motivo do CLOCK_TICK do TasksBoard).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])

  // O cartão aberto precisa acompanhar a atualização, senão o detalhe congela
  // num estado que o quadro atrás já superou.
  useEffect(() => {
    if (!selected) return
    const fresh = items.find((entry) => entry.id === selected.id)
    // Sumiu da lista (o agente reescreveu o plano, ou o filtro mudou): fecha o
    // detalhe. Sem isto, a tela seguia mostrando um cartão que não existe mais,
    // com o botão de dispensar apontando para um id morto.
    if (!fresh) setSelected(null)
    else if (fresh.revision !== selected.revision) setSelected(fresh)
  }, [items, selected])

  const byStatus = useMemo(() => {
    const map: Record<BoardItemStatus, BoardItem[]> = { pending: [], in_progress: [], completed: [] }
    for (const item of items) map[effectiveStatus(item)].push(item)
    return map
  }, [items])

  const done = byStatus.completed.length
  // Enquanto o painel está montado, ele é a fonte do contador da aba — assim o
  // App não repete a MESMA consulta em paralelo a cada mudança do quadro.
  useEffect(() => {
    onProgress?.(available ? { done, total: items.length } : null)
  }, [onProgress, available, done, items.length])
  const poAt = useMemo(
    () => items.reduce<string | null>((latest, item) => (item.poAt && (!latest || item.poAt > latest) ? item.poAt : latest), null),
    [items]
  )

  const dismiss = async (item: BoardItem): Promise<void> => {
    await window.api.boardDismiss(item.id, !item.dismissedAt)
    setSelected(null)
    await load()
  }

  const groups = useMemo(() => {
    const map = new Map<string, BoardItem[]>()
    for (const item of items) {
      const list = map.get(item.conversationId) ?? []
      list.push(item)
      map.set(item.conversationId, list)
    }
    return [...map.entries()]
  }, [items])

  return (
    <section className="board-panel" style={width !== undefined ? { flex: `0 0 ${width}px` } : undefined}>
      <header className="board-bar">
        <span className="board-seg" role="group" aria-label="Modo de visualização">
          <button type="button" className={mode === 'board' ? 'on' : ''} onClick={() => setMode('board')}>
            Quadro
          </button>
          <button type="button" className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')}>
            Lista
          </button>
        </span>
        <button
          type="button"
          className={`board-chip${wholeProject ? '' : ' on'}`}
          onClick={() => setWholeProject(false)}
        >
          Esta conversa
        </button>
        <button
          type="button"
          className={`board-chip${wholeProject ? ' on' : ''}`}
          onClick={() => setWholeProject(true)}
        >
          Projeto inteiro
        </button>
        <span className="board-bar-spacer" />
        <span className="board-count">
          {done}/{items.length}
        </span>
        <button type="button" className="nav-btn" onClick={onClose} title="Recolher painel">
          <IconCollapseRight />
        </button>
      </header>

      {poAt && (
        <div className="board-po-line">
          <span className="board-po-dot" aria-hidden="true" />
          <span>O PO atualizou o quadro {fmtAgo(poAt, now)}</span>
        </div>
      )}

      {!available ? (
        <p className="board-empty">
          O quadro precisa do banco de dados do app, que está indisponível agora. Assim que a
          persistência voltar, ele reaparece com o histórico inteiro.
        </p>
      ) : loading ? (
        <p className="board-empty">
          <IconSpinner className="spinner" size={14} /> Carregando o quadro…
        </p>
      ) : items.length === 0 ? (
        <p className="board-empty">
          Nenhuma tarefa ainda. Quando o agente declarar o plano de trabalho, cada passo aparece
          aqui e se marca sozinho conforme ele conclui.
        </p>
      ) : mode === 'board' ? (
        <div className="board-columns">
          {COLUMNS.map((column) => (
            <div className="board-column" key={column.key}>
              <div className="board-column-head">
                <span className={`board-key ${column.key}`} aria-hidden="true" />
                {column.label}
                <span className="board-column-count">{byStatus[column.status].length}</span>
              </div>
              {byStatus[column.status].map((item) => (
                <Card key={item.id} item={item} now={now} onOpen={setSelected} />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="board-list">
          {groups.map(([convId, list]) => (
            <div key={convId}>
              <div className="board-group">
                {conversationTitles[convId] ?? 'Conversa removida'}
                <span className="board-muted">
                  {' '}
                  — {list.length} tarefa{list.length > 1 ? 's' : ''}, {groupDone(list)} concluída
                  {groupDone(list) === 1 ? '' : 's'}
                </span>
              </div>
              {list.map((item) => {
                const status = effectiveStatus(item)
                return (
                  <button type="button" className="board-row" key={item.id} onClick={() => setSelected(item)}>
                    <span className={`board-check ${status}`} aria-hidden="true">
                      {status === 'completed' ? '✓' : ''}
                    </span>
                    <span className={`board-row-title ${status}`}>{effectiveTitle(item)}</span>
                    {(item.poTitle || item.poStatus) && <span className="board-tag po">PO</span>}
                    <span className="board-row-when">{fmtAgo(item.updatedAt, now)}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <Detail
          item={selected}
          conversationTitles={conversationTitles}
          onClose={() => setSelected(null)}
          onOpenConversation={onOpenConversation}
          onDismiss={dismiss}
        />
      )}
    </section>
  )
}

/** Contador do rótulo da aba (concluídas / total). */
export function boardProgress(items: BoardItem[]): { done: number; total: number } {
  return { done: items.filter((item) => effectiveStatus(item) === 'completed').length, total: items.length }
}
