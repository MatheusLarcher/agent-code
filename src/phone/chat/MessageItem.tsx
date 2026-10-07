/**
 * Uma mensagem do chat no celular: do usuário, resposta (Markdown do desktop), pensamento, avisos e ferramentas.
 * `resolveRef` (só o chat do Agent Manager, na aba Planos): os [[Nome]] de card saem na cor do tipo.
 */
import { memo, useState } from 'react'
import { CardRefText, Markdown, type CardRefResolver } from '@renderer/components/Markdown'
import { client } from '../app/runtime'
import { triggerDownload } from '../core/download'
import { basename, fmtBytes, fmtMsgTime, parseDownloads, readableMedia } from '../core/format'
import type { ChatMsg, UserMsg } from '../core/types'
import { Icon } from '../ui/icons'
import { BlurText, isPlainText } from './motion'
import { ToolCard } from './ToolCard'

/** A sua mensagem: cartão escuro com borda e degradê quente (não mais o bloco laranja chapado). */
function UserBubble({ m, flash, resolveRef, fresh }: { m: UserMsg; flash: boolean; resolveRef?: CardRefResolver | null; fresh: boolean }): JSX.Element {
  const text = m.text ? readableMedia(m.text) : ''
  return (
    <div className={`msg-row user${fresh ? ' pop' : ''}`}>
      <div className={`msg user${flash ? ' msg-highlight' : ''}`} data-mid={m.id}>
        {!!m.images?.length && (
          <div className="msg-imgs">
            {m.images.map((src, i) => (
              <img key={i} src={src} alt="" />
            ))}
          </div>
        )}
        {!!m.files?.length && (
          <div className="msg-files">
            {m.files.map((f, i) => (
              <span key={i} className="file-chip">📎 {f.name || 'arquivo'}{f.size ? ` · ${fmtBytes(f.size)}` : ''}</span>
            ))}
          </div>
        )}
        {text && (resolveRef ? <CardRefText text={text} resolveRef={resolveRef} /> : text)}
      </div>
      {m.queued && <div className="msg-queued">Na fila</div>}
      {m.canceled && <div className="msg-canceled">⊘ Mensagem cancelada</div>}
      {m.ts ? <div className="msg-time">{fmtMsgTime(m.ts)}</div> : null}
    </div>
  )
}

/** Texto do agente sem balão (o trilho do turno já diz de quem é). Novo e sem Markdown: entra palavra a palavra. */
function AssistantBubble({ id, text, answer, voiceReady, speaking, onSpeak, resolveRef, fresh }: {
  id: string
  text: string
  answer: boolean
  voiceReady: boolean
  speaking: boolean
  onSpeak: (id: string, text: string) => void
  resolveRef?: CardRefResolver | null
  fresh: boolean
}): JSX.Element {
  const parsed = parseDownloads(text)
  const blur = fresh && !resolveRef && isPlainText(parsed.clean)
  return (
    <div className={`msg assistant${answer ? ' answer' : ' narration'}${fresh && !blur ? ' pop' : ''}`}>
      {parsed.clean && (blur ? <div className="md"><BlurText text={parsed.clean} /></div> : <Markdown text={parsed.clean} resolveRef={resolveRef} />)}
      {parsed.paths.map((path) => (
        <button key={path} type="button" className="msg-dl" onClick={() => triggerDownload(client.fileUrl(path), path)}>
          <Icon name="download" size={15} /> Baixar {basename(path)}
        </button>
      ))}
      {/* "Ouvir": só na resposta final, e só quando o PC oferece voz (sintetizada lá). */}
      {answer && voiceReady && parsed.clean && (
        <button type="button" className={`msg-speak${speaking ? ' active' : ''}`} onClick={() => onSpeak(id, parsed.clean)}>
          <Icon name={speaking ? 'stop' : 'speaker'} size={15} /> {speaking ? 'Parar' : 'Ouvir'}
        </button>
      )}
    </div>
  )
}

/** Recolhido por padrão (como no PC): o raciocínio é longo e raramente é o que se quer ler no celular. */
function Thinking({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={`msg thinking${open ? ' open' : ''}`}>
      <button type="button" className="thinking-head" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Pensando…
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

export const MessageItem = memo(function MessageItem({ m, flash, voiceReady, speakingId, onSpeak, resolveRef, fresh = false }: {
  m: ChatMsg
  flash: boolean
  voiceReady: boolean
  speakingId: string | null
  onSpeak: (id: string, text: string) => void
  resolveRef?: CardRefResolver | null
  /** Chegou agora (não é histórico): anima a entrada. */
  fresh?: boolean
}): JSX.Element | null {
  switch (m.kind) {
    case 'user':
      return <UserBubble m={m} flash={flash} resolveRef={resolveRef} fresh={fresh} />
    case 'assistant-text':
      return (
        <AssistantBubble
          id={m.id}
          text={m.text}
          answer={!!m.answer}
          voiceReady={voiceReady}
          speaking={speakingId === m.id}
          onSpeak={onSpeak}
          resolveRef={resolveRef}
          fresh={fresh}
        />
      )
    case 'thinking':
      return <Thinking text={m.text} />
    case 'system':
      return (
        <div className="msg system session-chips">
          <span className="s-chip"><span className="s-dot" />sessão pronta</span>
          {m.model && <span className="s-chip"><b>{m.model}</b></span>}
        </div>
      )
    case 'error':
      return <div className="msg error">{m.text}</div>
    case 'status':
    case 'provider-switch':
    case 'account-switch':
      return <div className="msg system">{m.text}</div>
    case 'tool-use':
      return <ToolCard m={m} />
    default:
      return null
  }
})
