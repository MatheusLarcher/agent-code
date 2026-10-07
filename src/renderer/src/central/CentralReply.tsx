/**
 * A resposta de um destino na Central: bloco à esquerda com o fio na cor dele —
 * "projeto · conversa", cada comentário (cinza, "· ") com a SUA linha-resumo
 * logo embaixo (o agrupamento do chat, chatSteps.ts) e a resposta final com o
 * MESMO Markdown do chat. Clicar numa linha abre ali só os cartões daquela
 * resposta, lidos do destino (nunca copiados); outro clique fecha. "abrir
 * conversa ↗" leva ao turno no log completo.
 *
 * Entrada sem `steps` (antiga, ou de um PC antigo): o desenho de antes — todos
 * os comentários, a resposta e UMA linha do turno inteiro.
 */
import { useState, type CSSProperties } from 'react'
import type { CentralAnchor, CentralReplyEntry, CentralReplyStep } from '@shared/central'
import type { UIMessage } from '../types'
import { Markdown } from '../components/Markdown'
import { ToolCard, type ToolUseMessage } from '../components/ToolCard'
import { stepFallback } from '../components/chatSteps'
import { useStepOpen } from '../components/useStepOpen'
import type { LabelOf } from './centralView'
import { ActivityLine } from './ActivityLine'
import { CentralWho } from './CentralGlyph'
import { ReplyButton } from './CentralReplyUi'

export interface CentralReplyProps {
  reply: CentralReplyEntry
  labelFor: LabelOf
  turnTools: (anchor: CentralAnchor) => UIMessage[]
  onOpen: (convId: string, msgId?: string) => void
  /** Responder este bloco (só deste PC; ausente = sem a opção). */
  onReply?: () => void
}

export function CentralReply({ reply, labelFor, turnTools, onOpen, onReply }: CentralReplyProps): JSX.Element {
  const dest = labelFor(reply.anchor.convId)
  const steps = Array.isArray(reply.steps) ? reply.steps : null
  return (
    <div className="central-agent" style={{ '--c': dest.color } as CSSProperties} data-entry-id={reply.id}>
      {onReply && <ReplyButton onReply={onReply} />}
      <div className="central-who"><CentralWho label={dest} /></div>
      {steps ? (
        <StepList reply={reply} steps={steps} turnTools={turnTools} />
      ) : (
        reply.notes.map((note, i) => (
          <div key={i} className="central-note">
            <Markdown text={note} />
          </div>
        ))
      )}
      {reply.answer && (
        <div className="central-answer">
          <Markdown text={reply.answer} />
        </div>
      )}
      {!steps && <WholeTurnLine reply={reply} turnTools={turnTools} />}
      <button type="button" className="central-open" onClick={() => onOpen(reply.anchor.convId, reply.anchor.msgId)}>
        abrir conversa ↗
      </button>
    </div>
  )
}

/** O desenho de antes (sem `steps`): uma linha do turno inteiro, que abre todos os cartões. */
function WholeTurnLine({ reply, turnTools }: { reply: CentralReplyEntry; turnTools: CentralReplyProps['turnTools'] }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <ActivityLine activity={reply.activity} running={!reply.done} open={open} onToggle={() => setOpen((v) => !v)} />
      {open && <TurnTools tools={turnTools(reply.anchor)} />}
    </>
  )
}

/** Cada comentário com a sua linha; turno rodando sem passo ainda: a linha "trabalhando…". */
function StepList({ reply, steps, turnTools }: { reply: CentralReplyEntry; steps: CentralReplyStep[]; turnTools: CentralReplyProps['turnTools'] }): JSX.Element {
  const last = steps.length - 1
  return (
    <>
      {steps.map((step, i) => (
        <Step key={`${step.toolIds[0] ?? 'n'}:${i}`} reply={reply} step={step} index={i} running={!reply.done && i === last} turnTools={turnTools} />
      ))}
      {steps.length === 0 && !reply.done && <Step reply={reply} step={{ activity: reply.activity, toolIds: [] }} index={0} running turnTools={turnTools} />}
    </>
  )
}

function Step({ reply, step, index, running, turnTools }: {
  reply: CentralReplyEntry
  step: CentralReplyStep
  index: number
  running: boolean
  turnTools: CentralReplyProps['turnTools']
}): JSX.Element {
  const ids = Array.isArray(step.toolIds) ? step.toolIds : []
  const [open, toggle] = useStepOpen(`${reply.id}:${ids[0] ?? `n${index}`}`)
  const activity = step.activity ?? { segments: [], text: '', count: 0, errors: 0 }
  const segments = Array.isArray(activity.segments) ? activity.segments : []
  const hasLine = ids.length > 0 || running
  const fallback = running ? '' : stepFallback({ segments, now: activity.now }, ids.length, 0)
  return (
    <>
      {step.note && (
        <div className="central-note">
          <Markdown text={step.note} />
        </div>
      )}
      {hasLine && <ActivityLine activity={activity} running={running} open={open} onToggle={toggle} fallback={fallback} />}
      {hasLine && open && <TurnTools tools={turnTools(reply.anchor)} only={ids} />}
    </>
  )
}

/** Os cartões (os do chat; só leitura: lidos do destino a cada desenho). */
function TurnTools({ tools, only }: { tools: UIMessage[]; only?: readonly string[] }): JSX.Element {
  const cards = tools.filter((m): m is ToolUseMessage => m.kind === 'tool-use' && (!only || only.includes(m.id)))
  return (
    <div className="central-tools">
      {cards.length === 0 ? (
        <div className="central-faint">sem ações para mostrar aqui</div>
      ) : (
        cards.map((m) => <ToolCard key={m.id} m={m} />)
      )}
    </div>
  )
}
