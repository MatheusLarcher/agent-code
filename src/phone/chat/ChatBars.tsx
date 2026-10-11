/**
 * As faixas da conversa aberta: recuperação de turno (com contagem local de 1 s —
 * o retrato do PC só chega a cada 4 s) e o plano — numa conversa de handoff, o
 * PLACAR DAS ETAPAS DO PLANO que o main leu do banco (`conv.etapas`); nas outras,
 * o plano de tarefas do agente (TodoWrite/TaskCreate). O "trabalhando…" + parar
 * vive na linha ao vivo do turno (ChatTurns), não numa faixa aqui.
 */
import { useEffect, useState } from 'react'
import type { RemoteEtapasProgress } from '@shared/ipc'
import { taskCounts, type StepState } from '@shared/stepProgress'
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

type AgentTodoItems = NonNullable<ConvSummary['todoPlan']>['items']

/**
 * O plano da conversa. Com `conv.etapas` (conversa de handoff): o placar das
 * etapas do PLANO, contado pelo main no banco — prontas/total do roteiro, a lista
 * das etapas e, recolhida, a lista de tarefas do agente de hoje, só como detalhe
 * (ela recomeça a numeração a cada sessão nova e NUNCA é o contador). Sem
 * `etapas`: a lista do agente, como sempre.
 */
export function TodoPlan({ conv }: { conv: ConvSummary }): JSX.Element | null {
  return conv.etapas ? <EtapasPlan conv={conv} etapas={conv.etapas} /> : <AgentPlan conv={conv} />
}

function AgentItems({ items, className }: { items: AgentTodoItems; className: string }): JSX.Element {
  return (
    <div className={className}>
      {items.map((t, i) => (
        <div key={i} className={`todo-item ${t.status}`}>
          <span className="todo-mark">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'}</span>
          <span className="todo-text">{t.status === 'in_progress' ? t.activeForm || t.content : t.content}</span>
        </div>
      ))}
    </div>
  )
}

/** A lista de tarefas do agente (TodoWrite/TaskCreate) como contador: só fora do handoff. */
function AgentPlan({ conv }: { conv: ConvSummary }): JSX.Element | null {
  const [open, setOpen] = useState(true)
  const plan = conv.todoPlan
  if (!plan?.items?.length) return null
  const { done, total } = taskCounts(plan.items)
  const running = plan.items.find((t) => t.status === 'in_progress')
  return (
    <div className="todo-plan">
      <button type="button" className="todo-head" onClick={() => setOpen((o) => !o)}>
        <span className="todo-title">
          {plan.active ? '◔ ' : '✓ '}
          {done}/{total}
          {running && !open ? ` · ${running.activeForm || running.content}` : ' etapas'}
        </span>
        <span className="todo-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && <AgentItems items={plan.items} className="todo-list" />}
    </div>
  )
}

const STEP_MARK: Record<StepState, string> = { pronto: '✓', massa: '●', fila: '○', planta: '○', trinca: '✗' }

/** O placar do plano: prontas/total do roteiro (o main contou no banco), a lista das etapas e a atual destacada. */
function EtapasPlan({ conv, etapas }: { conv: ConvSummary; etapas: RemoteEtapasProgress }): JSX.Element {
  const [open, setOpen] = useState(true)
  const [agentOpen, setAgentOpen] = useState(false)
  const done = etapas.total > 0 && etapas.prontas === etapas.total
  const steps = [...etapas.steps].sort((a, b) => a.n - b.n)
  const atual = etapas.atual === null ? undefined : steps.find((s) => s.n === etapas.atual)
  const agent = conv.todoPlan?.items ?? []
  return (
    <div className="todo-plan etapas-plan">
      <button type="button" className="todo-head" onClick={() => setOpen((o) => !o)}>
        <span className="todo-copy">
          <span className="todo-title">
            {done ? '✓ ' : conv.busy ? '◔ ' : '○ '}
            {etapas.prontas}/{etapas.total}
            {atual && !open ? ` · ${atual.titulo}` : ' etapas'}
          </span>
          <span className="etapas-sub">
            {etapas.planTitulo} · Prompt {etapas.prompt.n} de {etapas.prompt.m}
          </span>
        </span>
        <span className="todo-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="todo-list etapas-list">
          {steps.map((s) => (
            <div key={s.id} className={`todo-item etapa ${s.state}${s.n === etapas.atual ? ' atual' : ''}`}>
              <span className="todo-mark">{STEP_MARK[s.state]}</span>
              <span className="todo-text">
                <span className="etapa-titulo">
                  {s.n}. {s.titulo}
                </span>
                {s.state === 'trinca' && s.motivo && <span className="etapa-motivo">{s.motivo}</span>}
              </span>
            </div>
          ))}
          {agent.length > 0 && (
            <div className="agent-todo">
              <button type="button" className="agent-todo-head" onClick={() => setAgentOpen((o) => !o)}>
                Tarefas do agente ({agent.length}) {agentOpen ? '▾' : '▸'}
              </button>
              {agentOpen && <AgentItems items={agent} className="agent-todo-list" />}
            </div>
          )}
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
