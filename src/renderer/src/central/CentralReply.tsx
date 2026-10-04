/**
 * A resposta de um destino na Central: bloco à esquerda com o fio na cor dele —
 * "projeto · conversa", os comentários (cinza, "· "), a resposta final com o
 * MESMO Markdown do chat e a linha-resumo das ações. Clicar na linha abre ali os
 * cartões de ferramenta DAQUELE turno, lidos do destino (nunca copiados); outro
 * clique fecha. "abrir conversa ↗" leva ao turno no log completo.
 */
import { useState, type CSSProperties } from 'react'
import type { CentralActivitySegment, CentralAnchor, CentralReplyEntry } from '@shared/central'
import type { UIMessage } from '../types'
import { Markdown } from '../components/Markdown'
import { ToolCard, type ToolUseMessage } from '../components/ToolCard'
import { actionsLabel, type LabelOf } from './centralView'
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
  const [open, setOpen] = useState(false)
  const dest = labelFor(reply.anchor.convId)
  return (
    <div className="central-agent" style={{ '--c': dest.color } as CSSProperties} data-entry-id={reply.id}>
      {onReply && <ReplyButton onReply={onReply} />}
      <div className="central-who"><CentralWho label={dest} /></div>
      {reply.notes.map((note, i) => (
        <div key={i} className="central-note">
          <Markdown text={note} />
        </div>
      ))}
      {reply.answer && (
        <div className="central-answer">
          <Markdown text={reply.answer} />
        </div>
      )}
      <ActivityLine reply={reply} open={open} onToggle={() => setOpen((v) => !v)} />
      {open && <TurnTools tools={turnTools(reply.anchor)} />}
      <button type="button" className="central-open" onClick={() => onOpen(reply.anchor.convId, reply.anchor.msgId)}>
        abrir conversa ↗
      </button>
    </div>
  )
}

const TONE_CLASS: Record<NonNullable<CentralActivitySegment['tone']>, string> = {
  strong: 'strong',
  add: 'add',
  rem: 'rem',
  ok: 'okc',
  bad: 'bad'
}

function Segments({ segments }: { segments: readonly CentralActivitySegment[] }): JSX.Element {
  return (
    <>
      {segments.map((s, i) =>
        s.tone === 'strong' ? (
          <b key={i}>{s.text}</b>
        ) : s.tone ? (
          <span key={i} className={TONE_CLASS[s.tone]}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  )
}

/** Terminado: ▸ + resumo + "N ações". Rodando: o spinner na cor do destino, o resumo até ali e "agora: …". */
function ActivityLine({ reply, open, onToggle }: { reply: CentralReplyEntry; open: boolean; onToggle: () => void }): JSX.Element {
  const a = reply.activity
  const segments = Array.isArray(a.segments) ? a.segments : []
  const count = typeof a.count === 'number' ? a.count : 0
  const running = !reply.done
  const idle = running && count === 0 && !a.now
  return (
    <button
      type="button"
      className={`central-act${running ? ' running' : ''}`}
      title={a.text || 'Clique para ver cada ação'}
      aria-expanded={open}
      onClick={onToggle}
    >
      {running ? <span className="central-spin" aria-hidden="true" /> : <span className="central-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>}
      <span className="central-sum">
        {idle ? (
          'trabalhando…'
        ) : (
          <>
            <Segments segments={segments} />
            {running && a.now && `${segments.length ? ' · ' : ''}agora: ${a.now}`}
          </>
        )}
      </span>
      {count > 0 && <span className="central-count">{actionsLabel(count)}</span>}
    </button>
  )
}

/** Os cartões do turno, como no chat (só leitura: lidos do destino a cada desenho). */
function TurnTools({ tools }: { tools: UIMessage[] }): JSX.Element {
  const cards = tools.filter((m): m is ToolUseMessage => m.kind === 'tool-use')
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
