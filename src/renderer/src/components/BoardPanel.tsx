import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import {
  boardItemAwaitingBadge,
  boardItemStatus as effectiveStatus,
  boardItemTitle as effectiveTitle,
  isBoardItemPoCorrected as isPoCorrected,
  type BoardItem,
  type BoardItemStatus,
  type PermissionRequest,
  type ProjectNode,
  type TaskBoardDetail,
  type TaskBoardItem,
  type TaskBoardStatus
} from '@shared/ipc'
import { activeColumnCrew, type CrewMember } from '../crew'
import type { Touch, Turn } from '../projectActivity'
import type { TodoItem } from '../types'
import { fmtAgo as fmtCrewAgo, fmtClock } from './AgentCrew'
import { BoardCardDetail, COLUMNS, fmtAgo } from './BoardCardDetail'
import { PoTag } from './BoardTagIcon'
import { CrewRoleIcon } from './CrewIcons'
import { IconCollapseRight, IconSpinner, IconTrash } from './Icons'
import { ProjectGraph } from './ProjectGraph'
import { NextPromptsStrip } from '../planning/NextPromptsStrip'
import { DeadlineTag, useCardDeadlines, type CardDeadline } from './BoardDeadline'
import { useBoardOpenRequest, type BoardOpenRequest } from './boardOpenCard'
import { PrintBadge, useProjectPrints } from './BoardPrints'
import { ReadRetry } from './ReadRetry'
// A coluna Concluído mostra só os 4 mais recentes (o contador segue com o total).
import { recentCompleted } from '@shared/boardView'
import { taskCounts, type TaskCounts } from '@shared/stepProgress'

/**
 * O quadro de tarefas do projeto: o que o agente declarou que ia fazer, e o que
 * ele já concluiu — marcado sozinho, sem ninguém arrastar cartão.
 *
 * É **somente leitura**, com uma exceção deliberada (arquivar um cartão). Quem
 * move o estado é o agente (pelo snapshot do CLI) e o PO; um terceiro dono do
 * mesmo estado só criaria conflito — a mesma razão pela qual o painel do
 * registro de tarefas também não move nada.
 */

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
  onProgress?: (progress: BoardProgress | null) => void
  /**
   * Elenco da conversa ativa (`conversationId`), já montado pelo App via
   * `buildCrew`. Alimenta as bolinhas do CABEÇALHO de cada coluna
   * (po/vigia/crítico/memória) — nunca por cartão, porque um papel só sabe em
   * qual conversa está, não em qual tarefa do registro. Só faz sentido em
   * "Esta conversa": em "Projeto inteiro" uma coluna mistura cartões de várias
   * conversas e o elenco de uma só mentiria sobre as outras.
   */
  crew?: CrewMember[]
  /** Conversas (fora desta) com uma permissão/pergunta esperando o usuário —
   *  o que a antiga aba Agentes mostrava em "Esperando você". Sem isto, uma
   *  segunda conversa presa numa pergunta ficaria invisível enquanto o Quadro
   *  estivesse aberto. */
  pendingPermissions?: { convId: string; title: string; request: PermissionRequest }[]
  onFocusPermission?: (convId: string) => void
  /**
   * O Mapa do projeto (`ProjectGraph`) — antes só dentro da aba Agentes, agora
   * um botão no Quadro que abre o mesmo mapa num overlay. Opcional porque o
   * Quadro continua útil mesmo sem projeto ativo (ex.: nenhuma conversa
   * selecionada ainda); nesse caso o botão simplesmente não aparece.
   */
  project?: {
    entries: ProjectNode[]
    touches: Touch[]
    turns: Turn[]
    missing: string[]
    truncated: boolean
    steps: TodoItem[]
    name: string
  }
  width?: number
  /** "Enviar mesmo assim" da faixa Próximos prompts (o despachante do App). */
  onSendAnyway?: (convId: string) => void
  /** Muda quando o aviso do chat pede para mostrar a faixa. */
  queueFocus?: number
  /** O chip da autorização do PO, no cabeçalho da faixa. */
  queueHeaderExtra?: React.ReactNode
  /** A faixa "Desde que você saiu", no topo (planning/AwaySummaryStrip.tsx). */
  topStrip?: React.ReactNode
  /** Abrir um cartão pelo id, pedido de fora (o clique num item do resumo). */
  openCard?: BoardOpenRequest | null
  onOpenCardDone?: (seq: number) => void
  /** O botão "Fala, PO" (o chat com o PO abre no lugar do chat principal). */
  onOpenPoChat?: () => void
  /** O cartão aberto no detalhe (o chip "Como está '<card>'?" do "Fala, PO"). */
  onSelectedChange?: (item: BoardItem | null) => void
}

/** Reexportados para quem já importava daqui; a regra mora em `@shared/ipc`,
 *  porque é a MESMA que o main usa para ordenar o quadro. */
export { effectiveStatus, effectiveTitle, isPoCorrected }

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

/** O tooltip dos selos do PO: o motivo atual do cartão, quando há. */
const TASK_STATUS_LABEL: Record<TaskBoardStatus, string> = {
  pending: 'Na fila',
  running: 'Executando',
  blocked: 'Bloqueada',
  review: 'Revisão',
  done: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Cancelada'
}

/** Status onde um lease solto é o desfecho normal (entrega feita), não um
 *  writer morto — mesmo critério que o antigo `TasksBoard` usava. */
const LEASE_HANDOFF: TaskBoardStatus[] = ['review', 'blocked', 'done', 'failed', 'cancelled']

function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

function describeLease(item: TaskBoardItem, now: number): { text: string; stale: boolean } | null {
  if (!item.leaseExpiresAt) return null
  const expires = Date.parse(item.leaseExpiresAt)
  if (!Number.isFinite(expires)) return null
  if (expires > now) return { text: `expira em ${fmtSpan(expires - now)}`, stale: false }
  if (LEASE_HANDOFF.includes(item.status)) return { text: 'lease solto', stale: false }
  return { text: `lease expirado há ${fmtSpan(now - expires)}`, stale: true }
}

/**
 * O balão do EXECUTOR: o mesmo detalhe que o antigo `TasksBoard`/`TaskRow`
 * mostrava por tarefa (objetivo, aceite, passos, evidências, lease, "Abrir a
 * conversa", id) — agora ancorado na bolinha do CARTÃO exato que
 * `TaskBoardItem.boardItemId` aponta, em vez de uma lista solta por conversa.
 */
function ExecutorBalloon({
  item,
  now,
  onOpenConversation
}: {
  item: TaskBoardItem
  now: number
  onOpenConversation: (convId: string) => void
}): JSX.Element {
  const [detail, setDetail] = useState<TaskBoardDetail | null>(null)
  const [loading, setLoading] = useState(false)
  // Busca preguiçosa: só quando o balão abre — igual ao detalhe do cartão do
  // agente logo abaixo, nunca para a fila inteira que ninguém clicou.
  const fetchedFor = useRef<string | null>(null)
  const [detailError, setDetailError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const key = `${item.id}#${attempt}`
    if (fetchedFor.current === key) return
    fetchedFor.current = key
    let alive = true
    setLoading(true)
    setDetailError(null)
    void window.api
      .tasksDetail(item.id)
      .then((result) => {
        if (alive) setDetail(result)
      })
      .catch((error: unknown) => {
        if (alive) setDetailError(error)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [item.id, attempt])

  const lease = describeLease(item, now)

  return (
    <div className="board-balloon" role="dialog" onClick={(e) => e.stopPropagation()}>
      <h4 className="board-balloon-title">
        executor <span className="board-balloon-tag">{TASK_STATUS_LABEL[item.status]}</span>
      </h4>
      <div className="board-balloon-owner">{item.title}</div>

      {item.goal && (
        <div className="board-balloon-block">
          <div className="board-balloon-label">Objetivo</div>
          {item.goal}
        </div>
      )}

      {item.acceptance.length > 0 && (
        <div className="board-balloon-block">
          <div className="board-balloon-label">Critérios de aceite</div>
          <ul className="board-balloon-list">
            {item.acceptance.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {loading && (
        <p className="board-balloon-loading">
          <IconSpinner className="spinner" size={12} /> carregando…
        </p>
      )}
      {!loading && detailError ? (
        <ReadRetry error={detailError} what="os passos" onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}

      {detail && detail.steps.length > 0 && (
        <div className="board-balloon-block">
          <div className="board-balloon-label">Passos</div>
          <ul className="board-balloon-list">
            {detail.steps.map((step) => (
              <li key={step.id}>
                {step.finishedAt ? '✓' : '›'} {step.kind}
                {step.finishedAt &&
                  ` · ${fmtSpan(Date.parse(step.finishedAt) - Date.parse(step.startedAt))}`}
                {step.error && ` — ${step.error}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail && (
        <div className="board-balloon-block">
          <div className="board-balloon-label">Evidências</div>
          {detail.deliverables.length === 0 ? (
            <p className="board-balloon-empty">Nada registrado ainda.</p>
          ) : (
            detail.deliverables.map((d) => (
              <div className="board-balloon-evid" key={d.id}>
                {d.kind} · {d.summary}
              </div>
            ))
          )}
        </div>
      )}

      <div className="board-balloon-foot">
        {lease && <span className={`board-balloon-lease${lease.stale ? ' stale' : ''}`}>{lease.text}</span>}
        {item.deliverables !== null && (
          <span className="board-balloon-evidcount">
            {item.deliverables} evidência{item.deliverables === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="board-balloon-foot plain">
        {item.conversationId && (
          <button
            type="button"
            className="board-balloon-btn"
            onClick={() => onOpenConversation(item.conversationId as string)}
          >
            Abrir a conversa
          </button>
        )}
        <span className="board-balloon-id" title={item.id}>
          {item.id}
        </span>
      </div>
    </div>
  )
}

/** Bolinhas do executor no CARTÃO — só aparecem no cartão que
 *  `TaskBoardItem.boardItemId` de fato aponta, nunca por aproximação de
 *  conversa (`stopPropagation` porque o cartão inteiro é clicável). */
function ExecutorDots({
  tasks,
  now,
  openKey,
  onToggle,
  onOpenConversation
}: {
  tasks: TaskBoardItem[]
  now: number
  openKey: string | null
  onToggle: (key: string) => void
  onOpenConversation: (convId: string) => void
}): JSX.Element {
  return (
    <span className="board-card-agents" onClick={(e) => e.stopPropagation()}>
      {tasks.map((task) => {
        const key = `exec:${task.id}`
        return (
          <span className="board-agent-dot-wrap" key={task.id}>
            <span
              role="button"
              tabIndex={0}
              className={`crew-mini board-agent-dot${task.status === 'running' ? ' pulse' : ''}`}
              style={{ ['--role' as string]: 'var(--crew-executor)' }}
              title={`executor · ${task.title}`}
              onClick={() => onToggle(key)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onToggle(key)
                }
              }}
            >
              <CrewRoleIcon role="executor" size={11} />
            </span>
            {openKey === key && <ExecutorBalloon item={task} now={now} onOpenConversation={onOpenConversation} />}
          </span>
        )
      })}
    </span>
  )
}

/** Balão simples de po/vigia/crítico/memória: o mesmo estado que o elenco já
 *  mostrava (`MemberCard`) — sem inventar goal/aceite, que esses papéis não
 *  têm. */
function CrewBalloon({ member, now }: { member: CrewMember; now: number }): JSX.Element {
  const time =
    member.state === 'working' && member.startedAt != null
      ? fmtClock(now - member.startedAt)
      : member.endedAt != null
        ? fmtCrewAgo(now - member.endedAt)
        : null
  return (
    <div className="board-balloon" role="dialog" onClick={(e) => e.stopPropagation()}>
      <h4 className="board-balloon-title">
        {member.name}
        {member.kind && <span className="board-balloon-tag">{member.kind}</span>}
      </h4>
      <div className="board-balloon-owner">
        {member.line.map((seg, i) => (
          <span key={i}>{seg.text}</span>
        ))}
      </div>
      {(time || member.badge) && (
        <div className="board-balloon-foot plain">
          <span className="board-balloon-lease">{time ?? member.badge?.text}</span>
        </div>
      )}
    </div>
  )
}

/** Bolinhas do CABEÇALHO de coluna: po/vigia/crítico/memória ativos NESTA
 *  conversa — nunca por cartão, porque esses papéis só sabem em qual conversa
 *  estão. */
function ColumnCrewDots({
  crew,
  columnKey,
  openKey,
  onToggle,
  now
}: {
  crew: CrewMember[]
  columnKey: string
  openKey: string | null
  onToggle: (key: string) => void
  now: number
}): JSX.Element | null {
  if (crew.length === 0) return null
  return (
    <span className="board-agent-dots" onClick={(e) => e.stopPropagation()}>
      {crew.map((member) => {
        const key = `crew:${columnKey}:${member.id}`
        return (
          <span className="board-agent-dot-wrap" key={member.id}>
            <button
              type="button"
              className={`crew-mini board-agent-dot${member.state === 'working' ? ' pulse' : ''}`}
              style={{ ['--role' as string]: `var(--crew-${member.role})` }}
              title={`${member.name} · ${member.state}`}
              onClick={() => onToggle(key)}
            >
              <CrewRoleIcon role={member.role} size={11} />
            </button>
            {openKey === key && <CrewBalloon member={member} now={now} />}
          </span>
        )
      })}
    </span>
  )
}

/** O selo "Aguardando você"/"Interrompido" — o mesmo no Quadro e na Lista. A dica
 *  mostra primeiro o que o usuário precisa fazer (quando o PO disse), depois o motivo. */
function AwaitingTag({
  item,
  badge
}: {
  item: BoardItem
  badge: NonNullable<ReturnType<typeof boardItemAwaitingBadge>>
}): JSX.Element {
  const action = item.poUserAction ? `O que você precisa fazer: ${item.poUserAction}` : null
  const hint = [action, item.poReason].filter(Boolean).join('\n')
  return (
    <span className={`board-tag awaiting ${badge.kind}`} title={hint || undefined}>
      {badge.label}
    </span>
  )
}

function Card({
  item,
  now,
  onOpen,
  onDelete,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  execTasks,
  openBalloon,
  onToggleBalloon,
  onOpenConversation,
  deadline,
  prints = 0
}: {
  item: BoardItem
  now: number
  onOpen: (item: BoardItem) => void
  /** Exclusão rápida direto do cartão, sem abrir o detalhe — reversível
   *  (é o mesmo dismiss do botão "Dispensar cartão" do detalhe). */
  onDelete: (item: BoardItem) => void
  /** Só arrastável na visão Quadro e no recorte "Esta conversa" — na visão
   *  Lista e em "Projeto inteiro" o cartão não é `draggable`. */
  draggable?: boolean
  dragging?: boolean
  onDragStart?: (e: DragEvent<HTMLButtonElement>, item: BoardItem) => void
  onDragEnd?: () => void
  /** Tarefas do executor vinculadas a ESTE cartão (`boardItemId` exato). */
  execTasks?: TaskBoardItem[]
  openBalloon: string | null
  onToggleBalloon: (key: string) => void
  onOpenConversation: (convId: string) => void
  /** O prazo da etapa (cartão `[etapa]` ligado a uma entrega). */
  deadline?: CardDeadline
  /** Quantos prints da tarefa testada o cartão tem (o 📷). */
  prints?: number
}): JSX.Element {
  const status = effectiveStatus(item)
  const awaiting = boardItemAwaitingBadge(item)
  return (
    <div className="board-card-wrap">
      <button
        type="button"
        className={`board-card ${status}${dragging ? ' dragging' : ''}`}
        draggable={draggable}
        onDragStart={draggable ? (e) => onDragStart?.(e, item) : undefined}
        onDragEnd={draggable ? onDragEnd : undefined}
        onClick={() => onOpen(item)}
      >
        <span className="board-card-top">
          <span className={`board-check ${status}`} aria-hidden="true">
            {status === 'completed' ? '✓' : ''}
          </span>
          <span className="board-card-title">{effectiveTitle(item)}</span>
        </span>
        {status === 'in_progress' && item.activeForm && (
          <span className="board-card-detail">{item.activeForm}</span>
        )}
        {execTasks && execTasks.length > 0 && (
          <ExecutorDots
            tasks={execTasks}
            now={now}
            openKey={openBalloon}
            onToggle={onToggleBalloon}
            onOpenConversation={onOpenConversation}
          />
        )}
        <span className="board-card-tags">
          {awaiting && <AwaitingTag item={item} badge={awaiting} />}
          {deadline && <DeadlineTag deadline={deadline} />}
          <PrintBadge count={prints} />
          {/* Cada selo do PO leva o motivo no tooltip: toda alteração dele se justifica. */}
          {item.origin === 'po' && <PoTag action="added" reason={item.poReason} />}
          {/* O rebaixamento de fim de turno não é o PO discordando: com o selo,
              "PO corrigiu/revisou" só repetiria o mesmo fato com o nome errado. */}
          {!awaiting && isPoCorrected(item) && <PoTag action="fixed" reason={item.poReason} />}
          {item.poTitle && item.origin === 'agent' && !isPoCorrected(item) && <PoTag action="rewrote" reason={item.poReason} />}
          {!awaiting && poAgreed(item) && <PoTag action="reviewed" reason={item.poReason} />}
          {status === 'completed' && <span className="board-tag auto">{fmtAgo(item.updatedAt, now)}</span>}
        </span>
      </button>
      <button
        type="button"
        className="board-card-delete"
        title="Excluir cartão"
        onClick={(e) => {
          // Fora do <button> do cartão de propósito (nada de botão dentro de
          // botão) — o stopPropagation aqui é só contra o próprio clique
          // borbulhando pro wrap, não uma dependência do aninhamento evitado.
          e.stopPropagation()
          onDelete(item)
        }}
      >
        <IconTrash size={13} />
      </button>
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
  crew,
  pendingPermissions,
  onFocusPermission,
  project,
  width,
  onSendAnyway,
  queueFocus,
  queueHeaderExtra,
  topStrip,
  openCard,
  onOpenCardDone,
  onOpenPoChat,
  onSelectedChange
}: Props): JSX.Element {
  const [mapOpen, setMapOpen] = useState(false)
  const [items, setItems] = useState<BoardItem[]>([])
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<'board' | 'list'>('board')
  const [wholeProject, setWholeProject] = useState(false)
  const [selected, setSelected] = useState<BoardItem | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Drag-and-drop: id do cartão sendo arrastado, coluna sob o cursor (para o
  // destaque), e o erro do último `boardMove` recusado — inline no rodapé,
  // sem inventar um sistema de notificação novo só para isto.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverStatus, setDragOverStatus] = useState<BoardItemStatus | null>(null)
  const [moveError, setMoveError] = useState<string | null>(null)
  // Qual bolinha (executor por cartão, ou papel por cabeçalho de coluna) tem o
  // balão aberto agora — uma só de cada vez, como o mockup. A chave carrega o
  // tipo (`exec:`/`crew:`) para nunca colidir entre os dois universos.
  const [openBalloon, setOpenBalloon] = useState<string | null>(null)
  // Tarefas do registro do executor, indexadas pelo cartão do Quadro que elas
  // referenciam de verdade (`boardItemId`) — o vínculo exato que a bolinha do
  // cartão precisa, sem aproximar por conversa.
  const [execByItem, setExecByItem] = useState<Record<string, TaskBoardItem[]>>({})

  // Leitura que falhou ou passou do prazo: o quadro fica com o que já tinha e
  // mostra "tentar de novo" (ReadRetry) — nunca o spinner preso.
  const [loadError, setLoadError] = useState<unknown>(null)
  const load = useCallback(async () => {
    if (!projectCwd) {
      setItems([])
      setLoading(false)
      return
    }
    try {
      const board = await window.api.boardList({
        projectCwd,
        conversationId: wholeProject ? undefined : conversationId
      })
      setAvailable(board.available)
      setItems(board.items)
      setLoadError(null)
    } catch (error) {
      setLoadError(error)
    } finally {
      setLoading(false)
    }
  }, [projectCwd, conversationId, wholeProject])

  const loadExec = useCallback(async () => {
    if (!projectCwd) {
      setExecByItem({})
      return
    }
    // As bolinhas do executor são de fundo: falhou, ficam as de antes até o próximo poll.
    const taskBoard = await window.api
      .tasksBoard({
        projectCwd,
        conversationId: wholeProject ? undefined : conversationId,
        includeFinished: true
      })
      .catch(() => null)
    if (!taskBoard) return
    if (!taskBoard.available) {
      setExecByItem({})
      return
    }
    const map: Record<string, TaskBoardItem[]> = {}
    for (const task of taskBoard.items) {
      if (!task.boardItemId) continue
      const list = map[task.boardItemId] ?? []
      list.push(task)
      map[task.boardItemId] = list
    }
    setExecByItem(map)
  }, [projectCwd, conversationId, wholeProject])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void loadExec()
  }, [loadExec])

  // O evento é o caminho rápido; o poll é a rede de segurança para o caso de
  // a mudança ter vindo de OUTRO PC (change feed do PostgreSQL).
  useEffect(() => window.api.onBoardChanged(() => void load()), [load])
  useEffect(() => window.api.onBoardChanged(() => void loadExec()), [loadExec])

  useEffect(() => {
    const id = setInterval(() => void load(), busy ? POLL_BUSY_MS : POLL_IDLE_MS)
    return () => clearInterval(id)
  }, [busy, load])

  useEffect(() => {
    const id = setInterval(() => void loadExec(), busy ? POLL_BUSY_MS : POLL_IDLE_MS)
    return () => clearInterval(id)
  }, [busy, loadExec])

  // Clicar fora de qualquer bolinha (ou de novo na mesma) fecha o balão aberto
  // — mesmo comportamento do mockup. `mousedown` (não `click`) para disparar
  // ANTES do clique de uma bolinha nova, senão a troca de balão piscaria fechado.
  useEffect(() => {
    if (!openBalloon) return
    const handler = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (target?.closest('.board-agent-dot-wrap')) return
      setOpenBalloon(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openBalloon])

  const toggleBalloon = useCallback((key: string): void => {
    setOpenBalloon((v) => (v === key ? null : key))
  }, [])

  // Bolinhas do cabeçalho de coluna (po/vigia/crítico/memória): só fazem
  // sentido em "Esta conversa" — em "Projeto inteiro" uma coluna mistura
  // cartões de várias conversas, e o elenco de uma só mentiria sobre as
  // outras.
  const columnCrew = useMemo(
    () => (wholeProject ? [] : activeColumnCrew(crew ?? [])),
    [crew, wholeProject]
  )

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
  useBoardOpenRequest({ request: openCard, items, conversationId, wholeProject, setWholeProject, open: setSelected, done: onOpenCardDone })
  useEffect(() => onSelectedChange?.(selected), [onSelectedChange, selected])

  const byStatus = useMemo(() => {
    const map: Record<BoardItemStatus, BoardItem[]> = { pending: [], in_progress: [], completed: [] }
    for (const item of items) map[effectiveStatus(item)].push(item)
    return map
  }, [items])

  // A contagem do cabeçalho e da aba: uma só (boardProgress → taskCounts).
  const { done, total, awaiting: awaitingCount } = useMemo(() => boardProgress(items), [items])
  // O prazo das etapas (a entrega ligada a cada cartão `[etapa]`).
  const deadlines = useCardDeadlines(projectCwd, window.api)
  // Os prints da tarefa visual (o 📷 de cada cartão).
  const prints = useProjectPrints(projectCwd || null)
  // Enquanto o painel está montado, ele é a fonte do contador da aba — assim o
  // App não repete a MESMA consulta em paralelo a cada mudança do quadro.
  useEffect(() => {
    // Pelos números (não pelo objeto): o App só redesenha quando a contagem muda.
    onProgress?.(available ? { done, total, awaiting: awaitingCount } : null)
  }, [onProgress, available, done, total, awaitingCount])
  const poAt = useMemo(
    () => items.reduce<string | null>((latest, item) => (item.poAt && (!latest || item.poAt > latest) ? item.poAt : latest), null),
    [items]
  )

  const dismiss = async (item: BoardItem): Promise<void> => {
    await window.api.boardDismiss(item.id, !item.dismissedAt)
    setSelected(null)
    await load()
  }

  // Drag desabilitado em "Projeto inteiro" e na visão Lista: mover um cartão
  // exige saber a CONVERSA dona dele sem ambiguidade, e as duas situações
  // acima podem misturar cartões de conversas diferentes na mesma coluna.
  const dragEnabled = mode === 'board' && !wholeProject

  const handleDragStart = useCallback((e: DragEvent<HTMLButtonElement>, item: BoardItem): void => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.id)
    setDraggingId(item.id)
  }, [])

  const handleDragEnd = useCallback((): void => {
    setDraggingId(null)
    setDragOverStatus(null)
  }, [])

  const handleDrop = useCallback(
    async (toStatus: BoardItemStatus): Promise<void> => {
      setDragOverStatus(null)
      const id = draggingId
      setDraggingId(null)
      if (!id) return
      const item = items.find((entry) => entry.id === id)
      if (!item) return
      if (effectiveStatus(item) === toStatus) return

      const previousPoStatus = item.poStatus
      // Otimista: pinta a posição nova já, e deixa o recarregamento (evento ou
      // erro abaixo) corrigir se algo divergir.
      setItems((prev) => prev.map((entry) => (entry.id === id ? { ...entry, poStatus: toStatus } : entry)))
      setMoveError(null)
      const result = await window.api.boardMove(id, toStatus)
      if (!result.ok) {
        setItems((prev) => prev.map((entry) => (entry.id === id ? { ...entry, poStatus: previousPoStatus } : entry)))
        setMoveError(result.message ?? 'Não foi possível mover o cartão.')
        return
      }
      await load()
    },
    [draggingId, items, load]
  )

  const groups = useMemo(() => {
    const map = new Map<string, BoardItem[]>()
    for (const item of items) {
      const list = map.get(item.conversationId) ?? []
      list.push(item)
      map.set(item.conversationId, list)
    }
    // A contagem do cabeçalho de cada grupo: a mesma do Quadro (taskCounts), uma vez por grupo.
    return [...map.entries()].map(([convId, list]) => [convId, list, taskCounts(list, effectiveStatus)] as const)
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
        {project && (
          <button
            type="button"
            className="board-chip"
            onClick={() => setMapOpen(true)}
            title="Mapa do projeto: os arquivos mais tocados nesta conversa"
          >
            Mapa
          </button>
        )}
        {/* O chat com o PO sobre as tarefas (poChat/), no lugar do chat principal. */}
        {onOpenPoChat && projectCwd && (
          <button type="button" className="board-chip po-chat-open" onClick={onOpenPoChat} title="Conversar com o PO sobre as tarefas do projeto">
            Fala, PO
          </button>
        )}
        <span className="board-bar-spacer" />
        <span className="board-count">
          {done}/{total}
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

      {pendingPermissions && pendingPermissions.length > 0 && (
        <div className="board-pending-line">
          {pendingPermissions.map((p) => (
            <button
              key={p.convId}
              type="button"
              className="board-pending-chip"
              onClick={() => onFocusPermission?.(p.convId)}
            >
              {p.title} · {p.request.questions ? 'pergunta' : p.request.toolName}
            </button>
          ))}
        </div>
      )}

      {topStrip}
      {/* Os prompts de implantação que esperam a vez (planning/NextPromptsStrip.tsx). */}
      <NextPromptsStrip
        projectCwd={projectCwd}
        conversationId={conversationId}
        wholeProject={wholeProject}
        conversationTitles={conversationTitles}
        onSendAnyway={onSendAnyway}
        onOpenConversation={onOpenConversation}
        focus={queueFocus}
        headerExtra={queueHeaderExtra}
      />

      {loadError ? <ReadRetry error={loadError} what="o quadro" onRetry={() => void load()} /> : null}
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
        loadError ? null : <p className="board-empty">
          Nenhuma tarefa ainda. Quando o agente declarar o plano de trabalho, cada passo aparece
          aqui e se marca sozinho conforme ele conclui.
        </p>
      ) : mode === 'board' ? (
        <div className="board-columns">
          {COLUMNS.map((column) => (
            <div
              className={`board-column${dragEnabled && dragOverStatus === column.status ? ' drag-over' : ''}`}
              key={column.key}
              onDragOver={
                dragEnabled
                  ? (e) => {
                      e.preventDefault()
                      setDragOverStatus(column.status)
                    }
                  : undefined
              }
              onDragLeave={
                dragEnabled ? () => setDragOverStatus((current) => (current === column.status ? null : current)) : undefined
              }
              onDrop={
                dragEnabled
                  ? (e) => {
                      e.preventDefault()
                      void handleDrop(column.status)
                    }
                  : undefined
              }
            >
              <div className="board-column-head">
                <span className={`board-key ${column.key}`} aria-hidden="true" />
                {column.label}
                <ColumnCrewDots
                  crew={columnCrew}
                  columnKey={column.key}
                  openKey={openBalloon}
                  onToggle={toggleBalloon}
                  now={now}
                />
                <span className="board-column-count">{byStatus[column.status].length}</span>
              </div>
              {(column.status === 'completed' ? recentCompleted(byStatus.completed) : byStatus[column.status]).map((item) => (
                <Card
                  key={item.id}
                  item={item}
                  now={now}
                  onOpen={setSelected}
                  onDelete={dismiss}
                  draggable={dragEnabled}
                  dragging={draggingId === item.id}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  execTasks={execByItem[item.id]}
                  openBalloon={openBalloon}
                  onToggleBalloon={toggleBalloon}
                  onOpenConversation={onOpenConversation}
                  deadline={deadlines.get(item.id)}
                  prints={prints.get(item.id)?.length ?? 0}
                />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="board-list">
          {groups.map(([convId, list, counts]) => (
            <div key={convId}>
              <div className="board-group">
                {conversationTitles[convId] ?? 'Conversa removida'}
                <span className="board-muted">
                  {' '}
                  — {counts.total} tarefa{counts.total > 1 ? 's' : ''}, {counts.done} concluída
                  {counts.done === 1 ? '' : 's'}
                </span>
              </div>
              {list.map((item) => {
                const status = effectiveStatus(item)
                const awaiting = boardItemAwaitingBadge(item)
                return (
                  <button type="button" className="board-row" key={item.id} onClick={() => setSelected(item)}>
                    <span className={`board-check ${status}`} aria-hidden="true">
                      {status === 'completed' ? '✓' : ''}
                    </span>
                    <span className={`board-row-title ${status}`}>{effectiveTitle(item)}</span>
                    {awaiting && <AwaitingTag item={item} badge={awaiting} />}
                    {deadlines.get(item.id) && <DeadlineTag deadline={deadlines.get(item.id)!} />}
                    <PrintBadge count={prints.get(item.id)?.length ?? 0} />
                    {(item.poTitle || (item.poStatus && !awaiting)) && <span className="board-tag po">PO</span>}
                    <span className="board-row-when">{fmtAgo(item.updatedAt, now)}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}

      {selected && (
        <BoardCardDetail
          item={selected}
          conversationTitles={conversationTitles}
          now={now}
          onClose={() => setSelected(null)}
          onOpenConversation={onOpenConversation}
          onDismiss={dismiss}
          findItem={(id) => items.find((entry) => entry.id === id)}
          onOpenItem={setSelected}
        />
      )}

      {moveError && (
        <div className="board-move-error" role="alert">
          <span>{moveError}</span>
          <button type="button" className="nav-btn" onClick={() => setMoveError(null)} title="Fechar aviso">
            ×
          </button>
        </div>
      )}

      {mapOpen && project && (
        <div className="board-map-overlay" onClick={() => setMapOpen(false)}>
          <div className="board-map-modal" onClick={(e) => e.stopPropagation()}>
            <header className="board-map-head">
              <span>Mapa do projeto</span>
              <button type="button" className="nav-btn" onClick={() => setMapOpen(false)} title="Fechar">
                ×
              </button>
            </header>
            <ProjectGraph
              entries={project.entries}
              touches={project.touches}
              turns={project.turns}
              rootName={project.name}
              truncated={project.truncated}
              missing={project.missing}
              steps={project.steps}
              embedded
            />
          </div>
        </div>
      )}
    </section>
  )
}

/** O rótulo da aba: concluídas / total (taskCounts) e quantos cartões esperam você. */
export interface BoardProgress extends Pick<TaskCounts, 'done' | 'total'> {
  awaiting: number
}

/** A contagem do Quadro pelo status efetivo (o do PO por cima do da fonte). */
export function boardProgress(items: BoardItem[]): BoardProgress {
  const { done, total } = taskCounts(items, effectiveStatus)
  return { done, total, awaiting: items.filter((item) => boardItemAwaitingBadge(item) !== null).length }
}
