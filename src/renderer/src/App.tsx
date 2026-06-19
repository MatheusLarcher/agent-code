import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BrowserState,
  ChatEvent,
  PermissionRequest,
  PickedElement
} from '@shared/ipc'
import { ChatPanel } from './components/ChatPanel'
import { BrowserPanel } from './components/BrowserPanel'

export type UserMessage = { kind: 'user'; id: string; text: string }
export type UIMessage = (ChatEvent | UserMessage) & {
  result?: { isError: boolean; text: string }
  /** Set on the final assistant text of a turn (the actual answer, shown in full font). */
  answer?: boolean
}

const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]

export function App(): JSX.Element {
  const [cwd, setCwd] = useState<string>('')
  const [model, setModel] = useState<string>(MODELS[0].id)
  const [skipPerms, setSkipPerms] = useState(false)
  const [started, setStarted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tokens, setTokens] = useState({ context: 0, output: 0, cost: 0 })
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [chips, setChips] = useState<PickedElement[]>([])
  const [browserState, setBrowserState] = useState<BrowserState>({
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    launched: false
  })
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const reduce = useCallback((e: ChatEvent) => {
    setMessages((prev) => {
      if (e.kind === 'assistant-text') {
        const i = prev.findIndex((m) => m.kind === 'assistant-text' && m.id === e.id)
        if (i >= 0) {
          const copy = [...prev]
          copy[i] = { ...e }
          return copy
        }
      }
      if (e.kind === 'tool-result') {
        const i = prev.findIndex((m) => m.kind === 'tool-use' && m.id === e.toolUseId)
        if (i >= 0) {
          const copy = [...prev]
          copy[i] = { ...copy[i], result: { isError: e.isError, text: e.text } }
          return copy
        }
      }
      if (e.kind === 'result') {
        // The result text duplicates the final answer (already shown) and the
        // cost is in the header — so we don't render it. We only use it to mark
        // the last assistant text of this turn as the "answer" (full font).
        const copy = [...prev]
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].kind === 'assistant-text') {
            copy[i] = { ...copy[i], answer: true }
            break
          }
        }
        return copy
      }
      return [...prev, e as UIMessage]
    })
    if (e.kind === 'result' || e.kind === 'error') setBusy(false)
    if (e.kind === 'result' && e.usage) {
      const u = e.usage
      setTokens((t) => ({
        context: u.input + u.cacheRead + u.cacheWrite,
        output: t.output + u.output,
        cost: t.cost + (e.costUsd ?? 0)
      }))
    }
  }, [])

  useEffect(() => {
    const offEvent = window.api.onAgentEvent(reduce)
    const offPerm = window.api.onPermissionRequest((r) => setPermission(r))
    const offState = window.api.onBrowserState(setBrowserState)
    const offPicked = window.api.onBrowserPicked((el) => {
      setChips((c) => [...c, el])
      composerRef.current?.focus()
    })
    return () => {
      offEvent()
      offPerm()
      offState()
      offPicked()
    }
  }, [reduce])

  const pickDir = async (): Promise<void> => {
    const dir = await window.api.pickDirectory()
    if (dir) setCwd(dir)
  }

  const start = async (): Promise<void> => {
    if (!cwd) {
      await pickDir()
      return
    }
    await window.api.startAgent({ cwd, model, skipPermissions: skipPerms })
    setStarted(true)
  }

  const sendMessage = async (text: string): Promise<void> => {
    let full = text.trim()
    if (chips.length) {
      const refs = chips
        .map(
          (c, i) =>
            `[#${i + 1} ${c.tagName}${c.id ? '#' + c.id : ''}] selector: ${c.selector}\n` +
            `text: ${c.text.slice(0, 400)}\nhtml: ${c.html.slice(0, 600)}`
        )
        .join('\n\n')
      full = `${full}\n\n--- Selected page elements ---\n${refs}`
    }
    if (!full) return
    setMessages((prev) => [...prev, { kind: 'user', id: 'u' + Date.now(), text }])
    setBusy(true)
    setChips([])
    await window.api.sendMessage(full)
  }

  const respond = async (behavior: 'allow' | 'deny', always: boolean): Promise<void> => {
    if (!permission) return
    await window.api.respondPermission({ id: permission.id, behavior, always })
    setPermission(null)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✦</span> Agent Code
        </div>
        <div className="project" onClick={pickDir} title="Choose project folder">
          <span className="project-label">Project</span>
          <span className="project-path">{cwd || 'Select a folder…'}</span>
        </div>
        <select className="model-select" value={model} onChange={(e) => setModel(e.target.value)} disabled={started}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <label className="skip-perms" title="Permite todas as ferramentas sem pedir permissão. Pode ligar/desligar a qualquer momento.">
          <input
            type="checkbox"
            checked={skipPerms}
            onChange={(e) => {
              const on = e.target.checked
              setSkipPerms(on)
              if (started) {
                void window.api.setBypass(on)
                if (on) setPermission(null)
              }
            }}
          />
          Permitir tudo
        </label>
        {!started ? (
          <button className="btn primary" onClick={start}>
            Connect
          </button>
        ) : (
          <span className={`session-pill ${skipPerms ? 'danger' : ''}`}>
            ● {skipPerms ? 'allow-all' : 'connected'}
          </span>
        )}
      </header>

      <div className="workspace">
        <ChatPanel
          messages={messages}
          started={started}
          busy={busy}
          tokens={tokens}
          permission={permission}
          chips={chips}
          onRemoveChip={(i) => setChips((c) => c.filter((_, idx) => idx !== i))}
          onSend={sendMessage}
          onInterrupt={() => window.api.interrupt()}
          onRespondPermission={respond}
          composerRef={composerRef}
        />
        <BrowserPanel state={browserState} />
      </div>
    </div>
  )
}
