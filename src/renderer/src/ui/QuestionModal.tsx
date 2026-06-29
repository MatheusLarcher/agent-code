import { useEffect, useMemo, useState } from 'react'
import type { PermissionRequest, QuestionAnswer } from '@shared/ipc'
import { CountdownBar } from './CountdownBar'

interface Props {
  request: PermissionRequest
  onAnswer: (answers: QuestionAnswer[]) => void
  onCancel: () => void
}

const OTHER = '__other__'

/**
 * Interactive AskUserQuestion dialog: the agent asks one or more multiple-choice
 * questions and the user picks (single or multi). An "Outro…" free-text option is
 * always offered (the SDK leaves the "Other" choice to the host). The picks are
 * fed back to the model as the tool's answer.
 */
export function QuestionModal({ request, onAnswer, onCancel }: Props): JSX.Element {
  const questions = useMemo(() => request.questions ?? [], [request.questions])
  // Per question: the set of selected option labels (single-select keeps one).
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []))
  // Per question: free-text typed into the "Outro…" field.
  const [other, setOther] = useState<string[]>(() => questions.map(() => ''))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setPicked((prev) => {
      const next = prev.map((s) => [...s])
      const cur = next[qi]
      if (multi) {
        const at = cur.indexOf(label)
        if (at >= 0) cur.splice(at, 1)
        else cur.push(label)
      } else {
        next[qi] = cur[0] === label ? [] : [label]
      }
      return next
    })
  }

  // Each question is answered once it has a pick (or non-empty "Outro" text).
  const resolved = (qi: number): string[] => {
    const labels = picked[qi].filter((l) => l !== OTHER)
    const text = other[qi].trim()
    const wantsOther = picked[qi].includes(OTHER) && text.length > 0
    return wantsOther ? [...labels, text] : labels
  }
  const ready = questions.every((_, qi) => resolved(qi).length > 0)

  const submit = (): void => {
    if (!ready) return
    onAnswer(questions.map((q, qi) => ({ header: q.header, question: q.question, selected: resolved(qi) })))
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-card question-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">O agente está perguntando</h3>
        {questions.map((q, qi) => {
          const isOther = picked[qi].includes(OTHER)
          return (
            <div key={qi} className="question-block">
              {q.header && <span className="question-header">{q.header}</span>}
              <p className="question-text">{q.question}</p>
              <div className="question-options">
                {q.options.map((op) => {
                  const on = picked[qi].includes(op.label)
                  return (
                    <button
                      key={op.label}
                      type="button"
                      className={`question-option${on ? ' selected' : ''}`}
                      onClick={() => toggle(qi, op.label, q.multiSelect)}
                    >
                      <span className="question-option-label">{op.label}</span>
                      {op.description && <span className="question-option-desc">{op.description}</span>}
                    </button>
                  )
                })}
                <button
                  type="button"
                  className={`question-option${isOther ? ' selected' : ''}`}
                  onClick={() => toggle(qi, OTHER, q.multiSelect)}
                >
                  <span className="question-option-label">Outro…</span>
                  <span className="question-option-desc">Escrever uma resposta própria</span>
                </button>
              </div>
              {isOther && (
                <input
                  className="question-other-input"
                  type="text"
                  autoFocus
                  placeholder="Sua resposta"
                  value={other[qi]}
                  onChange={(e) => setOther((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit()
                  }}
                />
              )}
            </div>
          )
        })}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn primary" disabled={!ready} onClick={submit}>
            Responder
          </button>
        </div>
        <CountdownBar deadline={request.deadline} />
      </div>
    </div>
  )
}
