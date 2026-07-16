import { useMemo, useState } from 'react'
import type { UIMessage } from '../types'

interface Question {
  id: string
  text: string
  ts?: number
  ratio: number
}

interface Cluster {
  ratio: number
  questions: Question[]
}

function clusterQuestions(messages: UIMessage[]): Cluster[] {
  const questions: Question[] = []
  messages.forEach((message, index) => {
    if (message.kind === 'user') {
      questions.push({ id: message.id, text: message.text, ts: message.ts, ratio: messages.length <= 1 ? 0 : index / (messages.length - 1) })
    }
  })
  const clusters: Cluster[] = []
  for (const question of questions) {
    const last = clusters[clusters.length - 1]
    if (last && question.ratio - last.ratio < 0.018) {
      last.questions.push(question)
      last.ratio = last.questions.reduce((sum, q) => sum + q.ratio, 0) / last.questions.length
    } else clusters.push({ ratio: question.ratio, questions: [question] })
  }
  return clusters
}

function preview(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > 150 ? `${clean.slice(0, 150)}...` : clean || '(imagem/anexo)'
}

export function QuestionMap({
  messages,
  scrollRatio,
  activeId,
  onSelect
}: {
  messages: UIMessage[]
  scrollRatio: number
  /** Id of the user message nearest the viewport center (measured from the real
   *  DOM by MessageList). When set, the active dot follows it exactly; the
   *  scrollRatio comparison below is only the fallback before any scroll. */
  activeId?: string | null
  onSelect: (id: string) => void
}): JSX.Element | null {
  const clusters = useMemo(() => clusterQuestions(messages), [messages])
  const [open, setOpen] = useState<number | null>(null)
  if (!clusters.length) return null
  let active = activeId ? clusters.findIndex((c) => c.questions.some((q) => q.id === activeId)) : -1
  if (active < 0) {
    active = 0
    for (let i = 0; i < clusters.length; i++) if (Math.abs(clusters[i].ratio - scrollRatio) < Math.abs(clusters[active].ratio - scrollRatio)) active = i
  }
  return (
    <nav className="question-map" aria-label="Mapa das suas perguntas" onMouseLeave={() => setOpen(null)}>
      <div className="question-map-track" />
      {clusters.map((cluster, index) => (
        <div className="question-map-point-wrap" style={{ top: `${cluster.ratio * 100}%` }} key={cluster.questions[0].id}>
          <button
            className={`question-map-point${index === active ? ' active' : ''}${cluster.questions.length > 1 ? ' grouped' : ''}`}
            aria-label={cluster.questions.length > 1 ? `${cluster.questions.length} perguntas` : preview(cluster.questions[0].text)}
            onMouseEnter={() => setOpen(index)}
            onFocus={() => setOpen(index)}
            onClick={() => cluster.questions.length === 1 && onSelect(cluster.questions[0].id)}
          />
          {open === index && (
            <div className="question-map-card">
              {cluster.questions.slice(0, 8).map((question) => (
                <button key={question.id} onClick={() => onSelect(question.id)}>
                  <strong>{preview(question.text)}</strong>
                  {question.ts && <span>{new Date(question.ts).toLocaleString('pt-BR')}</span>}
                </button>
              ))}
              {cluster.questions.length > 8 && <div className="question-map-more">+{cluster.questions.length - 8} perguntas adicionais</div>}
            </div>
          )}
        </div>
      ))}
    </nav>
  )
}
