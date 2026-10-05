/**
 * Mapa das suas perguntas na conversa (o índice leve que o PC publica em
 * `questions`): um tracinho por pergunta na borda; o toque mostra o trecho e leva
 * até ela (carregando a janela em volta se estiver fora das últimas mensagens).
 */
import { useState } from 'react'
import { client } from '../app/runtime'
import { fmtMsgTime, questionPreview } from '../core/format'
import { useStore } from '../core/store'
import type { UserMsg } from '../core/types'

export function QuestionMap(): JSX.Element | null {
  const questions = useStore(client.store, (s) => s.conversations.find((c) => c.id === s.convId)?.questions)
  const [open, setOpen] = useState<string | null>(null)
  if (!questions?.length) return null
  const max = Math.max(1, ...questions.map((q) => q.position || 0))

  const go = (q: (typeof questions)[number]): void => {
    setOpen(null)
    // Pergunta ainda na fila: o alvo é o eco "Na fila" com o mesmo texto.
    const queued = q.queued
      ? client.state.messages.find((m): m is UserMsg => m.kind === 'user' && !!(m as UserMsg).queued && (m as UserMsg).text === q.text)
      : undefined
    void client.goToMessage(queued ? queued.id : q.id)
  }

  return (
    <nav className="question-map" aria-label="Mapa das suas perguntas">
      {questions.map((q) => (
        <div key={q.id} className="question-point-wrap" style={{ top: `${((q.position || 0) / max) * 100}%` }}>
          <button
            type="button"
            className={`question-point${q.queued ? ' queued' : ''}`}
            aria-label={questionPreview(q.text)}
            onClick={() => setOpen((o) => (o === q.id ? null : q.id))}
          />
          {open === q.id && (
            <button type="button" className="question-card" onClick={() => go(q)}>
              <div className="question-card-text">{questionPreview(q.text)}</div>
              <div className="question-card-meta">{q.queued ? 'Na fila' : q.ts ? fmtMsgTime(q.ts) : 'Ir para a pergunta'}</div>
            </button>
          )}
        </div>
      ))}
    </nav>
  )
}
