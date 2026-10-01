import { useEffect, useMemo, useRef, useState } from 'react'
import type { PermissionRequest, QuestionAnswer } from '@shared/ipc'
import { CountdownBar } from './CountdownBar'
import { questionSpeechText } from '@shared/speechText'
import type { TtsControls } from '../components/MessageList'
import { IconMic, IconSpeaker, IconStopSmall } from '../components/Icons'
import { useQuickDictation } from './useQuickDictation'

interface Props {
  request: PermissionRequest
  onAnswer: (answers: QuestionAnswer[]) => void
  onCancel: () => void
  /** Clicar fora ou apertar Esc chama isto (não `onCancel`) — a pergunta continua
   *  pendente, só escondida; o chip do ChatPanel reabre o modal. Só o botão
   *  "Cancelar" descarta a pergunta de verdade. */
  onMinimize: () => void
  /** Qualquer clique dentro do modal: o usuário está respondendo, o prazo recomeça. */
  onActivity?: () => void
  /** Leitura em voz alta (mesmo controle do "Ouvir" das respostas). */
  tts?: TtsControls
  /** Falha do ditado (microfone/transcrição). */
  onError?: (msg: string) => void
}

const OTHER = '__other__'

/**
 * Interactive AskUserQuestion dialog: the agent asks one or more multiple-choice
 * questions and the user picks (single or multi). An "Outro…" free-text option is
 * always offered (the SDK leaves the "Other" choice to the host). The picks are
 * fed back to the model as the tool's answer.
 */
export function QuestionModal({ request, onAnswer, onCancel, onMinimize, onActivity, tts, onError }: Props): JSX.Element {
  const questions = useMemo(() => request.questions ?? [], [request.questions])
  // Per question: the set of selected option labels (single-select keeps one).
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []))
  // Per question: free-text typed into the "Outro…" field.
  const [other, setOther] = useState<string[]>(() => questions.map(() => ''))

  // Ditado no campo "Outro…": a pergunta que recebe o texto é a do clique no mic.
  const dictateFor = useRef(0)
  const dictation = useQuickDictation(
    (text) =>
      setOther((prev) => prev.map((v, i) => (i === dictateFor.current ? (v.trim() ? `${v.trim()} ${text}` : text) : v))),
    (msg) => onError?.(msg)
  )
  const dictate = (qi: number): void => {
    if (!dictation.recording) {
      dictateFor.current = qi
      if (!picked[qi].includes(OTHER)) toggle(qi, OTHER, questions[qi].multiSelect)
    }
    dictation.toggle()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onMinimize()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onMinimize])

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
    <div className="modal-overlay" onClick={onMinimize}>
      <div
        className="modal-card question-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onActivity}
      >
        <h3 className="modal-title">O agente está perguntando</h3>
        {questions.map((q, qi) => {
          const isOther = picked[qi].includes(OTHER)
          return (
            <div key={qi} className="question-block">
              {q.header && <span className="question-header">{q.header}</span>}
              <div className="question-text-row">
                <p className="question-text">{q.question}</p>
                {tts && (
                  <button
                    type="button"
                    className={`msg-speak ${tts.speakingId === `${request.id}:q${qi}` ? 'active' : ''}`}
                    onClick={() => tts.onToggleSpeak(`${request.id}:q${qi}`, questionSpeechText(q))}
                    title={tts.speakingId === `${request.id}:q${qi}` ? 'Parar leitura' : 'Ler pergunta e opções'}
                  >
                    {tts.speakingId === `${request.id}:q${qi}` ? <IconStopSmall size={14} /> : <IconSpeaker size={15} />}
                    {tts.speakingId === `${request.id}:q${qi}` ? 'Parar' : 'Ouvir'}
                  </button>
                )}
              </div>
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
                <div className="question-other-row">
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
                <button
                  type="button"
                  className={`question-mic${dictation.recording && dictateFor.current === qi ? ' recording' : ''}`}
                  disabled={dictation.busy || (dictation.recording && dictateFor.current !== qi)}
                  onClick={() => dictate(qi)}
                  title={dictation.recording ? 'Parar e transcrever' : 'Falar a resposta'}
                >
                  {dictation.recording && dictateFor.current === qi ? <IconStopSmall size={14} /> : <IconMic size={15} />}
                </button>
                </div>
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
