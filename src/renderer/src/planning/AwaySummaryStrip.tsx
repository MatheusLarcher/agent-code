import { useState } from 'react'
import { awayHeadline, type AwayEntry, type AwayKind, type AwaySummary } from './awaySummary'
import './awaySummary.css'

/**
 * A faixa "Desde que você saiu (há 2 h): 3 concluídas · 1 espera você · 1
 * falhou", no topo do quadro e da conversa. O clique no texto abre a lista; o
 * clique num item leva ao cartão (ou à conversa, no envio sem cartão); "ok"
 * fecha o resumo de vez.
 */

const KIND_LABEL: Record<AwayKind, string> = {
  concluida: 'Concluída',
  espera: 'Espera você',
  falhou: 'Falhou'
}

export function AwaySummaryStrip(props: {
  summary: AwaySummary | null
  onOpen(entry: AwayEntry): void
  onDismiss(projectKey: string): void
  /** Margem lateral do chat (a faixa do quadro encosta nas bordas). */
  inChat?: boolean
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const { summary } = props
  if (!summary) return null
  return (
    <div className={`away-strip${props.inChat ? ' in-chat' : ''}`} role="status" aria-label="Resumo desde que você saiu">
      <div className="away-strip-head">
        <button type="button" className="away-strip-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className="away-strip-text">{awayHeadline(summary)}</span>
          <span className="away-strip-chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        </button>
        <button type="button" className="next-btn away-strip-ok" onClick={() => props.onDismiss(summary.projectKey)}>
          ok
        </button>
      </div>
      {open && (
        <ul className="away-strip-list">
          {summary.entries.map((entry, i) => (
            <li key={`${entry.kind}:${entry.cardId ?? entry.conversationId}:${i}`}>
              <button
                type="button"
                className={`away-entry ${entry.kind}`}
                onClick={() => props.onOpen(entry)}
                title={entry.cardId ? 'Abrir o cartão no quadro' : 'Abrir a conversa'}
              >
                <span className="away-entry-kind">{KIND_LABEL[entry.kind]}</span>
                <span className="away-entry-title">{entry.title}</span>
                {entry.detail && <span className="away-entry-detail">{entry.detail}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
