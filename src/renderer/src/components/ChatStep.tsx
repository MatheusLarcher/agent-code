/**
 * Uma resposta do agente no chat resumido (chatSteps.ts): o texto dele (o
 * ChatRow de sempre — Markdown, Baixar, Ouvir, hora, "Comentar") e, embaixo, a
 * linha de passos daquela resposta, recolhida (ChatStepLine: chevron, ícone,
 * pílulas com contadores e o resumo). O clique abre ali os cartões (ToolCard,
 * via ChatRow, com o "✓ N" colado ao texto) e o pensamento; outro clique fecha.
 * O aberto/fechado é guardado pelo id da resposta (useStepOpen).
 *
 * No trilho do turno (chatLook.css): a 1ª resposta depois do pedido mostra o
 * avatar ✦; as outras, um ponto no trilho. Resposta que chegou ao vivo entra
 * com um "pop" e os contadores sobem (chatAnim); o histórico não anima.
 *
 * Em memo: só redesenha quando a própria resposta muda (texto, ferramenta nova
 * ou resultado, estado de "rodando") ou o contexto — o pedaço novo do texto em
 * andamento não redesenha as outras respostas.
 */
import { memo, useMemo } from 'react'
import { useFreshOnce } from '../chatAnim'
import { createdPlanFile, PlanFileLink } from '../planning/PlanFileLink'
import type { UIMessage } from '../types'
import { ChatRow, rowKey, type ChatRowContext } from './ChatRows'
import { ChatStepLine } from './ChatStepLine'
import { sameStep, stepActivity, stepFallback, stepHasLine, type ChatStep } from './chatSteps'
import { stepIcon, stepPills } from './stepPills'
import { useStepOpen } from './useStepOpen'
import '../central/centralFeed.css'
import './chatStep.css'

function CreatedPlanFiles({ tools, planDir }: { tools: UIMessage[]; planDir: ChatRowContext['planDir'] }): JSX.Element | null {
  if (!planDir) return null
  const paths = tools.flatMap((m) => {
    const created = m.kind === 'tool-use' ? createdPlanFile(m.name, m.input, m.result, planDir) : null
    return created ? [created] : []
  })
  return paths.length ? <>{paths.map((p) => <PlanFileLink key={p} path={p} />)}</> : null
}

function StepBody({ step, ctx, animate }: { step: ChatStep<UIMessage>; ctx: ChatRowContext; animate: boolean }): JSX.Element {
  const [open, toggle] = useStepOpen(step.id)
  const activity = useMemo(() => stepActivity(step), [step])
  const pills = useMemo(() => stepPills(step.tools), [step])
  const fallback = step.running ? '' : stepFallback(activity, step.tools.length, step.items.length - step.tools.length)
  // Os cartões abertos aqui dentro trocam o "done" pelo "✓ N" colado ao texto.
  const inner = useMemo<ChatRowContext>(() => ({ ...ctx, inStep: true }), [ctx])
  return (
    <>
      <ChatStepLine
        activity={activity}
        pills={pills}
        icon={stepIcon(pills)}
        running={step.running}
        live={!!ctx.liveLine}
        open={open}
        onToggle={toggle}
        fallback={fallback}
        animate={animate}
      />
      {/* Planejamento: o "Abrir" do arquivo criado no plano fica à vista mesmo recolhido (aberto, vai com o cartão). */}
      {!open && <CreatedPlanFiles tools={step.tools} planDir={ctx.planDir} />}
      {open && (
        <div className="central-tools">
          {step.items.map((m, i) => (
            <ChatRow key={rowKey(m, i)} m={m} ctx={inner} />
          ))}
        </div>
      )}
    </>
  )
}

export const ChatStepRow = memo(
  function ChatStepRow({ step, ctx }: { step: ChatStep<UIMessage>; ctx: ChatRowContext }): JSX.Element {
    const fresh = useFreshOnce(step.id, 'step')
    return (
      <div
        className={`chat-step${step.final ? ' final' : ''}${step.running ? ' running' : ''}${fresh ? ' ca-pop' : ''}`}
        data-step-id={step.id}
      >
        {step.text && <ChatRow m={step.text} ctx={ctx} />}
        {stepHasLine(step) && <StepBody step={step} ctx={ctx} animate={fresh} />}
      </div>
    )
  },
  (a, b) => a.ctx === b.ctx && sameStep(a.step, b.step)
)
