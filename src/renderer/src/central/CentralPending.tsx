/**
 * Perguntas e permissões dos destinos, no fim do feed da Central (respondidas
 * com o `convId` DO DESTINO), e a linha apagada das já respondidas.
 *
 * Uma pergunta só, de escolha única: cada opção responde no clique. Várias
 * perguntas, múltipla escolha ou "outro…": abre o QuestionModal daquela conversa
 * (`onOpenQuestion`; sem ele, abre a conversa, onde o modal aparece).
 * Permissão de ferramenta: Permitir / Sempre / Negar.
 */
import type { CSSProperties } from 'react'
import type { PermissionResponse } from '@shared/ipc'
import type { CentralQuestionEntry } from '@shared/central'
import { describeTool } from '../components/toolDescribe'
import type { CentralPendingQuestion } from './useCentral'
import { whoOf, type LabelOf } from './centralView'
import { CentralWho } from './CentralGlyph'

export interface CentralPendingProps {
  pending: readonly CentralPendingQuestion[]
  answer: (convId: string, res: PermissionResponse) => void
  onOpenQuestion: (convId: string) => void
}

export function CentralPending({ pending, answer, onOpenQuestion }: CentralPendingProps): JSX.Element {
  return (
    <>
      {pending.map((q) => (
        <PendingCard key={`${q.convId}:${q.request.id}`} q={q} answer={answer} onOpenQuestion={onOpenQuestion} />
      ))}
    </>
  )
}

function PendingCard({ q, answer, onOpenQuestion }: { q: CentralPendingQuestion } & Omit<CentralPendingProps, 'pending'>): JSX.Element {
  const who = whoOf(q.label)
  const req = q.request
  const style = { '--c': q.label.color } as CSSProperties
  const questions = req.questions ?? []
  if (!questions.length) {
    const { verb, detail } = describeTool(req.toolName, req.input)
    const respond = (behavior: 'allow' | 'deny', always = false): void =>
      answer(q.convId, { id: req.id, behavior, ...(always ? { always: true } : {}) })
    return (
      <div className="central-q" style={style} role="group" aria-label={`${who} pede permissão`}>
        <div className="central-who"><CentralWho label={q.label} suffix=" pede permissão:" /></div>
        <b>
          {verb}
          {detail ? ` ${detail}` : ''}
        </b>
        <div className="central-opts">
          <button type="button" className="central-opt" onClick={() => respond('allow')}>
            Permitir
          </button>
          <button type="button" className="central-opt" onClick={() => respond('allow', true)}>
            Sempre
          </button>
          <button type="button" className="central-opt" onClick={() => respond('deny')}>
            Negar
          </button>
        </div>
      </div>
    )
  }
  const first = questions[0]
  const simple = questions.length === 1 && !first.multiSelect
  return (
    <div className="central-q" style={style} role="group" aria-label={`${who} pergunta`}>
      <div className="central-who"><CentralWho label={q.label} suffix=" pergunta" /></div>
      <b>{first.question}</b>
      {questions.length > 1 && <span className="central-faint"> (+{questions.length - 1})</span>}
      <div className="central-opts">
        {simple ? (
          <>
            {first.options.map((o) => (
              <button
                key={o.label}
                type="button"
                className="central-opt"
                title={o.description || undefined}
                onClick={() =>
                  answer(q.convId, {
                    id: req.id,
                    behavior: 'allow',
                    answers: [{ header: first.header, question: first.question, selected: [o.label] }]
                  })
                }
              >
                {o.label}
              </button>
            ))}
            <button type="button" className="central-opt" onClick={() => onOpenQuestion(q.convId)}>
              <em>outro…</em>
            </button>
          </>
        ) : (
          <button type="button" className="central-opt" onClick={() => onOpenQuestion(q.convId)}>
            Responder…
          </button>
        )}
      </div>
    </div>
  )
}

/** Pergunta já respondida pela Central: uma linha apagada. */
export function CentralAnswered({ entry, labelFor }: { entry: CentralQuestionEntry; labelFor: LabelOf }): JSX.Element {
  const dest = labelFor(entry.convId)
  const text = `${entry.question} → ${entry.answer}`
  return (
    <div className="central-answered" style={{ '--c': dest.color } as CSSProperties} title={text}>
      <span className="central-answered-who"><CentralWho label={dest} /></span> · {text}
    </div>
  )
}
