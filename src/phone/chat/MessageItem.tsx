/** Uma mensagem do chat no celular: do usuário, resposta (Markdown do desktop), pensamento, avisos e ferramentas. */
import { memo, useState } from 'react'
import { Markdown } from '@renderer/components/Markdown'
import { client } from '../app/runtime'
import { triggerDownload } from '../core/download'
import { basename, fmtBytes, fmtMsgTime, parseDownloads, readableMedia } from '../core/format'
import type { ChatMsg, UserMsg } from '../core/types'
import { Icon } from '../ui/icons'
import { ToolCard } from './ToolCard'

function UserBubble({ m, flash }: { m: UserMsg; flash: boolean }): JSX.Element {
  return (
    <div className="msg-row user">
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
        {m.text && readableMedia(m.text)}
      </div>
      {m.queued && <div className="msg-queued">Na fila</div>}
      {m.canceled && <div className="msg-canceled">⊘ Mensagem cancelada</div>}
      {m.ts ? <div className="msg-time">{fmtMsgTime(m.ts)}</div> : null}
    </div>
  )
}

function AssistantBubble({ id, text, answer, voiceReady, speaking, onSpeak }: {
  id: string
  text: string
  answer: boolean
  voiceReady: boolean
  speaking: boolean
  onSpeak: (id: string, text: string) => void
}): JSX.Element {
  const parsed = parseDownloads(text)
  return (
    <div className={`msg assistant${answer ? ' answer' : ' narration'}`}>
      {parsed.clean && <Markdown text={parsed.clean} />}
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

export const MessageItem = memo(function MessageItem({ m, flash, voiceReady, speakingId, onSpeak }: {
  m: ChatMsg
  flash: boolean
  voiceReady: boolean
  speakingId: string | null
  onSpeak: (id: string, text: string) => void
}): JSX.Element | null {
  switch (m.kind) {
    case 'user':
      return <UserBubble m={m} flash={flash} />
    case 'assistant-text':
      return (
        <AssistantBubble
          id={m.id}
          text={m.text}
          answer={!!m.answer}
          voiceReady={voiceReady}
          speaking={speakingId === m.id}
          onSpeak={onSpeak}
        />
      )
    case 'thinking':
      return <Thinking text={m.text} />
    case 'system':
      return <div className="msg system">sessão pronta{m.model ? ` · ${m.model}` : ''}</div>
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
