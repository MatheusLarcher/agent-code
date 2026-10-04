/**
 * Um pedido na Central: a bolha à direita (texto + nomes dos anexos) e, debaixo,
 * o aviso discreto do destino — `→ projeto · conversa` na cor dele, clicável; no
 * hover, o porquê antes da seta e "· não era aqui" depois (só pedido roteado,
 * entregue e deste PC). Adotado (A1): `em projeto · conversa`, sem os dois.
 * Esperando destino: o cartão "Para onde vai?" — sem botões se o pedido é de
 * outro PC (só o dono o encaminha).
 */
import type { CSSProperties } from 'react'
import type { CentralRequestEntry } from '@shared/central'
import { splitMediaText } from '@shared/inlineMedia'
import { CentralGlyph } from './CentralGlyph'
import { ReplyButton, ReplyQuote } from './CentralReplyUi'
import { isRoutedEntry } from './centralEntries'
import { ASK_REASON_TEXT, optionView, requestNotice, type LabelOf } from './centralView'

export interface CentralRequestProps {
  entry: CentralRequestEntry
  /** Pedido deste PC (`isOwnEntry`): só ele escolhe destino e diz "não era aqui". */
  own: boolean
  labelFor: LabelOf
  onOpen: (convId: string, msgId?: string) => void
  onNotHere: (entryId: string) => void
  onChoose: (entryId: string, option: number) => void
  /** Responder este pedido (só entregue e deste PC; ausente = sem a opção). */
  onReply?: () => void
}

export function CentralRequest(props: CentralRequestProps): JSX.Element {
  const { entry } = props
  return (
    <>
      <div className="central-me" data-entry-id={entry.id}>
        {props.onReply && <ReplyButton onReply={props.onReply} />}
        {entry.replyTo && <ReplyQuote quote={entry.replyTo} labelFor={props.labelFor} />}
        <Bubble entry={entry} />
        <RequestLine {...props} />
      </div>
      {entry.state === 'asking' && entry.ask && isRoutedEntry(entry) && <AskCard {...props} />}
    </>
  )
}

/** A bolha, com o nome de cada anexo no ponto do texto. */
function Bubble({ entry }: { entry: CentralRequestEntry }): JSX.Element {
  const names = entry.attachments ?? []
  const parts = splitMediaText(entry.text)
  const inText = new Set<number>()
  for (const part of parts) if ('media' in part) inText.add(part.media)
  // Anexo sem marcador no texto (imagem vinda do celular): vai depois do texto.
  const rest = names.filter((_, i) => !inText.has(i + 1))
  return (
    <div className="central-bubble">
      {parts.map((part, i) =>
        'media' in part ? (
          <span key={i} className="central-att">
            {names[part.media - 1] ?? `mídia ${part.media}`}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
      {rest.length > 0 && (
        <span className="central-atts">
          {rest.map((name, i) => (
            <span key={i} className="central-att">
              {name}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

/** Debaixo da bolha: decidindo, não entregue, ou para onde foi. */
function RequestLine({ entry, own, labelFor, onOpen, onNotHere }: CentralRequestProps): JSX.Element | null {
  if (entry.state === 'routing') return <div className="central-route central-wait">decidindo…</div>
  if (entry.state === 'failed') return <div className="central-route central-bad">não foi entregue</div>
  const notice = requestNotice(entry, labelFor)
  if (!notice) return null
  const movable = own && !notice.adopted && !entry.injected && isRoutedEntry(entry)
  return (
    <div className="central-route" style={{ '--c': notice.color } as CSSProperties}>
      {notice.why && <span className="central-why">{notice.why} ·</span>}
      <span aria-hidden="true">{notice.adopted ? 'em' : '→'}</span>
      <button
        type="button"
        className="central-to"
        title="Abrir a conversa neste pedido"
        onClick={() => onOpen(notice.anchor.convId, notice.anchor.msgId)}
      >
        {notice.to}
      </button>
      {movable && (
        <button type="button" className="central-move" title="Tirar daqui e escolher outro destino" onClick={() => onNotHere(entry.id)}>
          · não era aqui
        </button>
      )}
    </div>
  )
}

/** "Para onde vai?": uma opção por botão, a mais provável com a borda laranja. */
function AskCard({ entry, own, labelFor, onChoose }: CentralRequestProps): JSX.Element {
  const ask = entry.ask!
  const options = Array.isArray(ask.options) ? ask.options : []
  return (
    <div className={`central-ask${own ? '' : ' foreign'}`} role="group" aria-label="Para onde vai?">
      <p>
        Para onde vai?
        {own && ASK_REASON_TEXT[ask.reason] && <span className="central-faint"> ({ASK_REASON_TEXT[ask.reason]})</span>}
      </p>
      <div className="central-opts">
        {options.map((o, i) => {
          const view = optionView(o, labelFor)
          const content = (
            <>
              <CentralGlyph icon={view.icon} kind={view.glyph} />
              {view.label}
              {view.sub && <em>{view.sub}</em>}
            </>
          )
          const cls = `central-opt${own && i === ask.best ? ' best' : ''}`
          return own ? (
            <button key={i} type="button" className={cls} onClick={() => onChoose(entry.id, i)}>
              {content}
            </button>
          ) : (
            <span key={i} className={cls}>
              {content}
            </span>
          )
        })}
      </div>
      {!own && <div className="central-foreign">aguardando o outro PC</div>}
    </div>
  )
}
