/**
 * As faixas da conversa aberta: recuperação de turno (com contagem local de 1 s —
 * o retrato do PC só chega a cada 4 s) e o plano de tarefas do agente
 * (TodoWrite/TaskCreate). O "trabalhando…" + parar vive na linha ao vivo do turno
 * (ChatTurns), não numa faixa aqui.
 */
import { useEffect, useState } from 'react'
import { client } from '../app/runtime'
import { useStore } from '../core/store'
import type { ConvSummary } from '../core/types'

export function useTick(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export function TurnRecovery({ conv }: { conv: ConvSummary }): JSX.Element | null {
  const r = conv.recovery
  const now = useTick(!!r && r.scheduledAt > 0)
  if (!r) return null
  let time: string
  if (r.scheduledAt <= 0) time = `Tentativas automáticas encerradas (${r.attempt}/${r.maxAttempts})`
  else {
    const seconds = Math.max(0, Math.ceil((r.scheduledAt - now) / 1000))
    const clock = new Date(r.scheduledAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    time = `Nova tentativa em ${seconds}s · ${clock}`
  }
  return (
    <div className="turn-recovery">
      <span className="turn-recovery-clock">◷</span>
      <div className="turn-recovery-copy">
        <strong>{r.reason === 'limit' ? 'Limite do Claude atingido' : 'Resposta interrompida'}</strong>
        <span>{time}</span>
      </div>
      <button type="button" onClick={() => client.recoveryAction('retry')}>Tentar agora</button>
      <button type="button" onClick={() => client.recoveryAction('cancel')}>Cancelar</button>
    </div>
  )
}

export function TodoPlan({ conv }: { conv: ConvSummary }): JSX.Element | null {
  const [open, setOpen] = useState(true)
  const plan = conv.todoPlan
  if (!plan?.items?.length) return null
  const done = plan.items.filter((t) => t.status === 'completed').length
  const running = plan.items.find((t) => t.status === 'in_progress')
  return (
    <div className="todo-plan">
      <button type="button" className="todo-head" onClick={() => setOpen((o) => !o)}>
        <span className="todo-title">
          {plan.active ? '◔ ' : '✓ '}
          {done}/{plan.items.length}
          {running && !open ? ` · ${running.activeForm || running.content}` : ' etapas'}
        </span>
        <span className="todo-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="todo-list">
          {plan.items.map((t, i) => (
            <div key={i} className={`todo-item ${t.status}`}>
              <span className="todo-mark">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}</span>
              <span className="todo-text">{t.status === 'in_progress' ? t.activeForm || t.content : t.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Faixa "reconectando…" (vale em todas as abas). */
export function ReconnectBar(): JSX.Element | null {
  const text = useStore(client.store, (s) => s.reconnectText)
  if (text === null) return null
  return (
    <div className="bar reconnect">
      <span className="spinner" /> <span>{text}</span>
    </div>
  )
}
