import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskBoard, TaskBoardDetail, TaskBoardItem, TaskBoardStatus } from '@shared/ipc'
import { IconChevronDown, IconClock, IconSpinner } from './Icons'

/**
 * The task ledger as the third view of the agents panel.
 *
 * It is READ-ONLY on purpose. The state machine, the lease and the attempt
 * budget live in the repository; a button here that moved a task would be a
 * second owner of the same rules, and the two would drift. What this view adds
 * over the subagent list is precisely what the ledger knows and the tracks do
 * not: owner, lease, attempts and evidence.
 */

interface Props {
  /** Folder of the active conversation — the board is scoped to it by default. */
  projectCwd: string
  /** True while the main agent is running a turn: the queue moves, so poll faster. */
  busy: boolean
  /** Opens the conversation a task belongs to. */
  onOpenConversation: (convId: string) => void
}

const STATUS_LABEL: Record<TaskBoardStatus, string> = {
  pending: 'Na fila',
  running: 'Executando',
  blocked: 'Bloqueada',
  review: 'Revisão',
  done: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Cancelada'
}

/** Section order mirrors the board's own ranking: who needs a person comes first. */
const SECTIONS: { status: TaskBoardStatus; title: string }[] = [
  { status: 'review', title: 'Esperando o crítico' },
  { status: 'running', title: 'Executando' },
  { status: 'blocked', title: 'Bloqueadas' },
  { status: 'pending', title: 'Na fila' }
]

const FINISHED: TaskBoardStatus[] = ['done', 'failed', 'cancelled']

/** Statuses where a released lease is the normal handoff, not an abandoned writer. */
const HANDOFF: TaskBoardStatus[] = ['review', 'blocked', 'done', 'failed', 'cancelled']

const POLL_BUSY_MS = 6000
const POLL_IDLE_MS = 30000
/** O relógio só alimenta o texto do lease, que fala em minutos — um tique por
 *  segundo re-renderizaria o quadro inteiro 60× para trocar nada na tela. */
const CLOCK_TICK_MS = 15000

function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}min`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`
}

interface Lease {
  text: string
  stale: boolean
}

/**
 * The repository releases a lease by EXPIRING it (`lease_expires_at = now`), not
 * by clearing the token — so "expired" alone cannot tell a clean handoff from a
 * writer that died. The status does: in `review`/`blocked`/terminal the handoff
 * is the expected thing; in `running` an expired lease is the anomaly worth a
 * warning.
 */
export function describeLease(item: TaskBoardItem, now: number): Lease | null {
  if (!item.leaseExpiresAt) return null
  const expires = Date.parse(item.leaseExpiresAt)
  if (!Number.isFinite(expires)) return null
  if (expires > now) return { text: `expira em ${fmtSpan(expires - now)}`, stale: false }
  if (HANDOFF.includes(item.status)) return { text: 'lease solto', stale: false }
  return { text: `lease expirado há ${fmtSpan(now - expires)}`, stale: true }
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])
  return now
}

function Evidence({ item }: { item: TaskBoardItem }): JSX.Element | null {
  // `null` is "not counted", which is not the same as zero — saying "sem
  // evidência" for a queued task would be an accusation about work not started.
  if (item.deliverables === null) return null
  if (item.deliverables === 0) {
    return (
      <span className="task-evid none" title="Fechar sem entregável seria só uma afirmação">
        sem evidência
      </span>
    )
  }
  return (
    <span className="task-evid">
      {item.deliverables} {item.deliverables === 1 ? 'evidência' : 'evidências'}
    </span>
  )
}

function TaskRow({
  item,
  now,
  onOpenConversation
}: {
  item: TaskBoardItem
  now: number
  onOpenConversation: (convId: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<TaskBoardDetail | null>(null)
  const [loading, setLoading] = useState(false)
  // "Já busquei", separado de "tenho resultado": o main devolve `null` quando a
  // consulta falha, e usar a ausência de resultado como guarda faria o efeito
  // disparar de novo a cada render — IPC em loop enquanto o card ficasse aberto.
  const fetched = useRef(false)
  const lease = describeLease(item, now)

  // Steps/deliverables/events are fetched only when the card is expanded: on a
  // remote PostgreSQL, loading them for the whole queue would be three round
  // trips per task to show something nobody opened.
  useEffect(() => {
    if (!open || fetched.current) return
    fetched.current = true
    let alive = true
    setLoading(true)
    void window.api
      .tasksDetail(item.id)
      .then((result) => {
        if (alive) setDetail(result)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, item.id])

  return (
    <article className={`task ${item.status}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="task-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`task-dot ${item.status}`} aria-hidden="true" />
        <span className="task-main">
          <span className="task-title">{item.title}</span>
          <span className="task-sub">
            {item.ownerAgent ? (
              <span className="task-owner">{item.ownerAgent}</span>
            ) : (
              <span>sem dono</span>
            )}
            {lease && (
              <>
                <span className="task-sep">·</span>
                <span className={`task-lease${lease.stale ? ' stale' : ''}`}>
                  <IconClock size={11} /> {lease.text}
                </span>
              </>
            )}
            {item.writeScopeAllow.slice(0, 2).map((glob) => (
              <span className="task-scope" key={glob}>
                {glob}
              </span>
            ))}
          </span>
        </span>
        <span className="task-meta">
          <span className={`task-attempts${item.attempts >= item.maxAttempts ? ' last' : ''}`}>
            {item.attempts}/{item.maxAttempts}
          </span>
          <Evidence item={item} />
          <IconChevronDown size={12} className="task-caret" />
        </span>
      </button>
      {item.status === 'running' && <span className="task-progress" aria-hidden="true" />}

      {open && (
        <div className="task-detail">
          {item.goal && <p className="td-goal">{item.goal}</p>}

          {item.acceptance.length > 0 && (
            <div className="td-block">
              <div className="td-label">Critérios de aceite</div>
              <ul className="td-list">
                {item.acceptance.map((line, i) => (
                  <li key={i}>
                    <span className="mk" aria-hidden="true">
                      •
                    </span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {loading && (
            <p className="td-loading">
              <IconSpinner className="spinner" size={13} /> carregando o histórico…
            </p>
          )}

          {detail && detail.steps.length > 0 && (
            <div className="td-block">
              <div className="td-label">Passos</div>
              <ul className="td-list td-steps">
                {detail.steps.map((step) => (
                  <li key={step.id}>
                    <span className={`mk${step.finishedAt ? ' ok' : ' run'}`} aria-hidden="true">
                      {step.finishedAt ? '✓' : '›'}
                    </span>
                    <span>
                      {step.kind}
                      {step.finishedAt &&
                        ` · ${fmtSpan(Date.parse(step.finishedAt) - Date.parse(step.startedAt))}`}
                      {step.error && <span className="td-err"> — {step.error}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {detail && (
            <div className="td-block">
              <div className="td-label">Evidências</div>
              {detail.deliverables.length === 0 ? (
                <p className="td-empty">
                  Nada registrado. Fechar como concluída aqui seria só uma afirmação.
                </p>
              ) : (
                <div className="td-evid">
                  {detail.deliverables.map((d) => (
                    <span className={`evid${d.verified ? '' : ' unver'}`} key={d.id}>
                      {d.kind} · {d.summary}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {detail && detail.events.length > 0 && (
            <div className="td-block">
              <div className="td-label">Último registro</div>
              <ul className="td-list td-steps">
                {detail.events.slice(-3).map((e) => (
                  <li key={e.id}>
                    <span className="mk" aria-hidden="true">
                      ·
                    </span>
                    <span>
                      {e.kind} — {e.summary}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="td-foot">
            {item.conversationId && (
              <button
                type="button"
                className="td-btn"
                onClick={() => onOpenConversation(item.conversationId as string)}
              >
                Abrir a conversa
              </button>
            )}
            <span className="td-id" title={item.id}>
              {item.id}
            </span>
          </div>
        </div>
      )}
    </article>
  )
}

export function TasksBoard({ projectCwd, busy, onOpenConversation }: Props): JSX.Element {
  const [board, setBoard] = useState<TaskBoard | null>(null)
  // O quadro preserva a história por padrão; o chip permite voltar ao recorte
  // apenas de tarefas abertas quando isso for o que a pessoa precisa.
  const [includeFinished, setIncludeFinished] = useState(true)
  const [onlyProject, setOnlyProject] = useState(true)
  const [hidden, setHidden] = useState<TaskBoardStatus[]>([])
  const reqRef = useRef(0)
  const now = useNow()

  const load = useCallback(async (): Promise<void> => {
    const seq = ++reqRef.current
    const result = await window.api.tasksBoard({
      ...(onlyProject && projectCwd ? { projectCwd } : {}),
      includeFinished
    })
    // Trocar de projeto/filtro rápido não pode deixar uma resposta velha vencer.
    if (seq === reqRef.current) setBoard(result)
  }, [projectCwd, onlyProject, includeFinished])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), busy ? POLL_BUSY_MS : POLL_IDLE_MS)
    return () => clearInterval(id)
  }, [load, busy])

  const counts = useMemo(() => {
    const map = {} as Record<TaskBoardStatus, number>
    for (const item of board?.items ?? []) map[item.status] = (map[item.status] ?? 0) + 1
    return map
  }, [board])

  const visible = useMemo(
    () => (board?.items ?? []).filter((item) => !hidden.includes(item.status)),
    [board, hidden]
  )

  const toggle = (status: TaskBoardStatus): void =>
    setHidden((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]
    )

  if (board && !board.available) {
    return (
      <p className="agents-empty">
        O registro de tarefas está <b>desligado</b> porque não há armazenamento autoritativo ativo.
        Abra <b>Configurações → Dados</b> para verificar.
      </p>
    )
  }

  const finishedCount = FINISHED.reduce((sum, s) => sum + (counts[s] ?? 0), 0)

  return (
    <>
      <div className="task-filters">
        {SECTIONS.map(({ status }) => (
          <button
            type="button"
            key={status}
            className={`task-chip${hidden.includes(status) ? ' off' : ' on'}`}
            onClick={() => toggle(status)}
          >
            {STATUS_LABEL[status]} <span className="n">{counts[status] ?? 0}</span>
          </button>
        ))}
        <button
          type="button"
          className={`task-chip${includeFinished ? ' on' : ' off'}`}
          onClick={() => setIncludeFinished((v) => !v)}
          title="Concluídas, falhas e canceladas"
        >
          Terminadas {includeFinished && <span className="n">{finishedCount}</span>}
        </button>
        {/* Sem conversa aberta não há projeto para filtrar. Deixar a caixa marcada
            e mostrar tudo seria a tela afirmando um recorte que não aplicou. */}
        <label
          className="task-scope-toggle"
          title={projectCwd ? projectCwd : 'Abra uma conversa para filtrar por projeto'}
        >
          <input
            type="checkbox"
            disabled={!projectCwd}
            checked={onlyProject && !!projectCwd}
            onChange={(e) => setOnlyProject(e.target.checked)}
          />
          só este projeto
        </label>
      </div>

      <div className="agents-body">
        {!board ? (
          <p className="agents-empty">Lendo o registro…</p>
        ) : visible.length === 0 ? (
          <p className="agents-empty">
            Nenhuma tarefa registrada {onlyProject ? 'neste projeto' : ''}.
            <br />
            <br />O registro é usado quando o agente <b>divide um pedido grande</b> entre
            subagentes — cada um com critério de aceite e escopo de escrita próprios. Pedidos
            simples são resolvidos direto e não aparecem aqui.
          </p>
        ) : (
          <>
            {SECTIONS.map(({ status, title }) => {
              const rows = visible.filter((item) => item.status === status)
              if (rows.length === 0) return null
              return (
                <section className="agents-section" key={status}>
                  <h3 className={`agents-section-title${status === 'review' ? ' warn' : ''}`}>
                    {title}
                    <span className="agents-section-badge">{rows.length}</span>
                  </h3>
                  {rows.map((item) => (
                    <TaskRow
                      key={item.id}
                      item={item}
                      now={now}
                      onOpenConversation={onOpenConversation}
                    />
                  ))}
                </section>
              )
            })}
            {(() => {
              const rows = visible.filter((item) => FINISHED.includes(item.status))
              if (rows.length === 0) return null
              return (
                <section className="agents-section">
                  <h3 className="agents-section-title">
                    Terminadas
                    <span className="agents-section-badge">{rows.length}</span>
                  </h3>
                  {rows.map((item) => (
                    <TaskRow
                      key={item.id}
                      item={item}
                      now={now}
                      onOpenConversation={onOpenConversation}
                    />
                  ))}
                </section>
              )
            })()}
          </>
        )}
      </div>
    </>
  )
}
