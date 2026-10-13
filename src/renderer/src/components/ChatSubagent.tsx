/**
 * Um subagente na linha do tempo do chat: a chamada Task/Agent do agente
 * principal vira um item filho da resposta (chatSteps.ts → `subagents`), com o
 * robozinho no lugar do ponto do trilho. Recolhido: quem é, a tarefa, quantas
 * ações e o estado. O clique abre ali as ações do subagente (o mesmo ToolCard
 * do passo, com o "✓ N") e o relatório; outro clique fecha. O aberto/fechado
 * é guardado como o do passo (useStepOpen, id `sub:<chamada>`).
 *
 * A fonte são as mensagens, então vale ao vivo e no histórico. O que pode
 * carregar segredo passa pela máscara (chatSubagentModel.ts) antes de desenhar.
 */
import { useMemo } from 'react'
import type { UIMessage } from '../types'
import { ChatRow, rowKey, type ChatRowContext } from './ChatRows'
import type { ChatSubagent } from './chatSteps'
import { safeToolMessage, STATE_LABEL, subagentName, subagentReport, subagentState, subagentTask } from './chatSubagentModel'
import { StepKindIcon } from './StepKindIcon'
import { useStepOpen } from './useStepOpen'
import './chatSubagent.css'

export function ChatSubagentRow({ sub, ctx }: { sub: ChatSubagent<UIMessage>; ctx: ChatRowContext }): JSX.Element {
  const callId = sub.call.kind === 'tool-use' ? sub.call.id : ''
  const regionId = `sub-${callId}`
  const [open, toggle] = useStepOpen(`sub:${callId}`)
  const state = subagentState(sub)
  const name = subagentName(sub)
  const task = subagentTask(sub)
  const actions = sub.tools.length
  // Os cartões abertos aqui dentro trocam o "done" pelo "✓ N" colado ao texto, como no passo.
  const inner = useMemo<ChatRowContext>(() => ({ ...ctx, inStep: true }), [ctx])
  const tools = useMemo(() => (open ? sub.tools.map(safeToolMessage) : []), [open, sub.tools])
  const report = open ? subagentReport(sub) : undefined
  return (
    <div className={`chat-sub is-${state}`} data-sub-id={callId}>
      <button
        type="button"
        className="chat-sub-line"
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        title={task ? `${name}: ${task}` : name}
        onClick={toggle}
      >
        <span className="chat-sub-ico" aria-hidden="true">
          <StepKindIcon kind="agent" size={13} />
        </span>
        <span className="central-chev" aria-hidden="true">›</span>
        <span className="chat-sub-title">
          <strong>{name}</strong>
          {task && <span className="chat-sub-task">{task}</span>}
        </span>
        <span className="chat-sub-count">{actions} {actions === 1 ? 'ação' : 'ações'}</span>
        <span className={`chat-sub-state ${state}`}>{STATE_LABEL[state]}</span>
      </button>
      {open && (
        <div id={regionId} role="region" aria-label={`Ações de ${name}`} className="central-tools chat-sub-tools">
          {tools.length > 0 ? (
            tools.map((m, i) => <ChatRow key={rowKey(m, i)} m={m} ctx={inner} />)
          ) : (
            <p className="chat-sub-empty">{state === 'trabalhando' ? 'Ainda sem ações.' : 'Nenhuma ação registrada.'}</p>
          )}
          {report && (
            <div className="chat-sub-result">
              <div className="chat-sub-label">Resultado</div>
              <p>{report}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
