/**
 * O que cada subagente está fazendo, na aba Conversa — um cartão por trilha
 * (não por papel), logo acima do composer. Recolhido: quem é, a tarefa, o
 * estado e a última ação. Aberto: o histórico das ações (o mesmo ToolCard do
 * chat) e o resultado, quando a tarefa o trouxe.
 *
 * Só ao vivo: lê as trilhas que o App já mantém em memória (agentTracks.ts),
 * nada novo é salvo. Sem trilhas, não ocupa espaço.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { MAX_FINISHED_TRACKS, MAX_STEPS, sortTracks, type AgentTrack, type TrackMap } from '../agentTracks'
import { ToolCard } from './ToolCard'
import { fmtDuration } from './fmtDuration'
import { activityState, agentName, currentActivity, safeStepMessages, safeSummary, STATE_LABEL, taskText } from './chatAgentActivityModel'
import './chatAgentActivity.css'

/** O relógio dos cartões: só bate (1 s) enquanto algum agente roda. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return active ? now : Date.now()
}

function AgentCard({ track, now }: { track: AgentTrack; now: number }): JSX.Element {
  const [open, setOpen] = useState(false)
  const regionId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  // Ao abrir, traz o histórico para dentro da área rolável dos cartões (com zoom alto ela é baixa).
  useEffect(() => { if (open) bodyRef.current?.scrollIntoView?.({ block: 'nearest' }) }, [open])
  const state = activityState(track)
  const name = agentName(track)
  const task = taskText(track)
  const actions = Math.max(track.stepCount, track.task?.toolUses ?? 0)
  const elapsed = Math.max(0, (track.endedAt ?? now) - track.startedAt)
  const steps = open ? safeStepMessages(track) : []
  const summary = open ? safeSummary(track) : undefined
  return (
    <li className={`chat-agent-card is-${state}`}>
      <button type="button" className="chat-agent-head" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)}>
        <span className="chat-agent-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="chat-agent-main">
          <span className="chat-agent-title">
            <strong>{name}</strong>
            <span className="chat-agent-task" title={task}>{task}</span>
          </span>
          <span className="chat-agent-now" title={currentActivity(track)}>{currentActivity(track)}</span>
        </span>
        <span className="chat-agent-meta">
          <span className={`chat-agent-state ${state}`}>{STATE_LABEL[state]}</span>
          <small>{fmtDuration(elapsed)} · {actions} {actions === 1 ? 'ação' : 'ações'}</small>
        </span>
      </button>
      {open && (
        <div ref={bodyRef} id={regionId} role="region" aria-label={`Histórico de ${name}: ${task}`} className="chat-agent-body">
          {track.stepCount > track.steps.length && (
            <p className="chat-agent-trim">Mostrando as últimas {track.steps.length} de {track.stepCount} ações.</p>
          )}
          {steps.length > 0 ? (
            <div className="chat-agent-steps">{steps.map((m) => <ToolCard key={m.id} m={m} />)}</div>
          ) : (
            <p className="chat-agent-empty">{track.status === 'running' ? 'Ainda sem ações.' : 'Nenhuma ação registrada nesta sessão.'}</p>
          )}
          {summary && (
            <div className="chat-agent-result">
              <div className="chat-agent-label">Resultado</div>
              <p>{summary}</p>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

export function ChatAgentActivity({ tracks }: { tracks?: TrackMap }): JSX.Element | null {
  const list = useMemo(() => (tracks ? sortTracks(tracks) : []), [tracks])
  const running = list.some((t) => t.status === 'running')
  const now = useNow(running)
  if (list.length === 0) return null
  const finished = list.some((t) => t.status !== 'running')
  return (
    <section className="chat-agent-activity" aria-label="Atividade dos agentes desta conversa">
      <ul>{list.map((t) => <AgentCard key={t.id} track={t} now={now} />)}</ul>
      {finished && (
        <p className="chat-agent-note">
          Histórico temporário desta sessão: some ao fechar o app (até {MAX_STEPS} ações por agente e {MAX_FINISHED_TRACKS} agentes encerrados).
        </p>
      )}
    </section>
  )
}
