import type { RefObject } from 'react'
import type { PermissionRequest, PickedElement } from '@shared/ipc'
import type { UIMessage } from '../App'
import { MessageList } from './MessageList'
import { Composer } from './Composer'

interface Props {
  messages: UIMessage[]
  started: boolean
  busy: boolean
  tokens: { context: number; output: number; cost: number }
  permission: PermissionRequest | null
  chips: PickedElement[]
  onRemoveChip: (i: number) => void
  onSend: (text: string) => void
  onInterrupt: () => void
  onRespondPermission: (behavior: 'allow' | 'deny', always: boolean) => void
  composerRef: RefObject<HTMLTextAreaElement | null>
}

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function ChatPanel(props: Props): JSX.Element {
  const { messages, started, busy, tokens, permission } = props
  return (
    <section className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Chat</span>
        <div className="token-meter" title="Uso de tokens da sessão">
          <span className="tok ctx" title="Tokens de contexto na última resposta">
            ⬚ {fmt(tokens.context)} ctx
          </span>
          <span className="tok out" title="Tokens de saída acumulados">
            ↓ {fmt(tokens.output)} out
          </span>
          <span className="tok cost" title="Custo estimado acumulado">
            ${tokens.cost.toFixed(4)}
          </span>
        </div>
      </div>

      {messages.length === 0 && (
        <div className="empty-state">
          <div className="empty-logo">✦</div>
          <h2>Claude Code</h2>
          <p>
            {started
              ? 'Ask Claude to build, edit, or research. It can open the embedded browser on the right when needed.'
              : 'Pick a project folder and start a session to begin.'}
          </p>
        </div>
      )}

      <MessageList messages={messages} busy={busy} />

      {permission && (
        <div className="permission-card">
          <div className="permission-head">
            Allow <strong>{permission.toolName}</strong>?
          </div>
          <pre className="permission-input">{JSON.stringify(permission.input, null, 2).slice(0, 800)}</pre>
          <div className="permission-actions">
            <button className="btn small" onClick={() => props.onRespondPermission('allow', false)}>
              Allow once
            </button>
            <button className="btn small primary" onClick={() => props.onRespondPermission('allow', true)}>
              Always allow
            </button>
            <button className="btn small ghost" onClick={() => props.onRespondPermission('deny', false)}>
              Deny
            </button>
          </div>
        </div>
      )}

      <Composer
        disabled={!started}
        busy={busy}
        chips={props.chips}
        onRemoveChip={props.onRemoveChip}
        onSend={props.onSend}
        onInterrupt={props.onInterrupt}
        textareaRef={props.composerRef}
      />
    </section>
  )
}
