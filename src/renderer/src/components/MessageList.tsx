import { useEffect, useRef, useState } from 'react'
import type { UIMessage } from '../App'

function ToolCard({ m }: { m: Extract<UIMessage, { kind: 'tool-use' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const niceName = m.name.replace(/^mcp__browser__/, '🌐 ').replace(/^mcp__[^_]+__/, '')
  return (
    <div className={`tool-card ${m.result?.isError ? 'tool-error' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{niceName}</span>
        {m.result ? (
          <span className="tool-badge ok">{m.result.isError ? 'error' : 'done'}</span>
        ) : (
          <span className="tool-badge run">running…</span>
        )}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-section-label">input</div>
          <pre>{JSON.stringify(m.input, null, 2).slice(0, 1500)}</pre>
          {m.result && (
            <>
              <div className="tool-section-label">result</div>
              <pre>{m.result.text.slice(0, 2500)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function MessageList({ messages, busy }: { messages: UIMessage[]; busy: boolean }): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="message-list">
      {messages.map((m, idx) => {
        switch (m.kind) {
          case 'user':
            return (
              <div key={m.id} className="msg user">
                <div className="bubble">{m.text}</div>
              </div>
            )
          case 'assistant-text':
            return (
              <div key={m.id} className={`msg assistant ${m.answer ? '' : 'narration'}`}>
                <div className="bubble">{m.text}</div>
              </div>
            )
          case 'thinking':
            return (
              <div key={m.id + idx} className="msg thinking">
                <div className="bubble">{m.text}</div>
              </div>
            )
          case 'tool-use':
            return <ToolCard key={m.id} m={m} />
          case 'system':
            return (
              <div key={'sys' + idx} className="msg system-note">
                Session ready · {m.model} · {m.cwd}
              </div>
            )
          case 'result':
            // Not rendered: the answer is already in the chat and the cost is
            // shown in the token meter header.
            return null
          case 'error':
            return (
              <div key={m.id} className="msg result-note err">
                {m.text}
              </div>
            )
          default:
            return null
        }
      })}
      {busy && (
        <div className="msg assistant">
          <div className="bubble typing">
            <span></span>
            <span></span>
            <span></span>
          </div>
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}
