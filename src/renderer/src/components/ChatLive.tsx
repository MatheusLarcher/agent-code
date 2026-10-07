/**
 * A linha "ao vivo" no fim do chat enquanto o agente trabalha — no lugar da
 * antiga bolha de três pontos. No trilho do turno, um ponto pulsando; o que ele
 * faz AGORA com brilho correndo no texto ("Lendo auth.ts…", "Rodando os
 * testes…", senão "Pensando…") e o tempo do turno (desde o pedido).
 *
 * A mesma no chat principal, no planejamento (ChatPanel → MessageList) e no
 * monitor do Escritório (TurnRows). O texto vem do resumo da Central
 * (summarizeActivity, a forma "agora").
 */
import { useEffect, useMemo, useState } from 'react'
import { summarizeActivity } from '../central/activitySummary'

interface Loose {
  kind?: string
  name?: string
  input?: unknown
  result?: unknown
  parentToolUseId?: string | null
  injected?: boolean
  ts?: number
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** O que o agente faz agora: a última ferramenta da trilha principal ainda sem resultado; senão, "Pensando…". */
export function liveLabel(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Loose
    if (!m || typeof m !== 'object') continue
    if (m.kind === 'user' && !m.injected) break
    if (m.kind === 'tool-use' && m.parentToolUseId == null) {
      if (m.result != null) break
      const now = summarizeActivity([{ name: m.name ?? '', input: m.input, result: null }], { running: true }).now
      if (now) return capital(now)
      break
    }
  }
  return 'Pensando…'
}

/** Quando começou o turno: a hora do último pedido do usuário (null = não se sabe). */
function turnStart(messages: readonly unknown[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Loose
    if (m?.kind === 'user' && !m.injected) return typeof m.ts === 'number' && m.ts > 0 ? m.ts : null
  }
  return null
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

export function ChatLive({ messages }: { messages: readonly unknown[] }): JSX.Element {
  const label = useMemo(() => liveLabel(messages), [messages])
  const since = useMemo(() => turnStart(messages), [messages])
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const start = since != null && since <= now ? since : mountedAt
  return (
    <div className="chat-live" role="status" aria-label={`Agente trabalhando: ${label}`}>
      {/* A chave troca com a ação: o texto novo entra com um fade curto. */}
      <span key={label} className="chat-live-text">
        {label}
      </span>
      <span className="chat-live-time">{elapsed(now - start)}</span>
    </div>
  )
}
