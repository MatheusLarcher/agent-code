/**
 * A linha ao vivo no fim do chat enquanto o agente trabalha: o loading, o que
 * ele faz agora e o tempo do turno. Para o usuário saber que o agente está VIVO:
 * - ferramenta principal rodando → "Rodando X · há M:SS" (o tempo dela);
 * - raciocínio aberto (heartbeat `thinkingSince`) → "Pensando… · há M:SS", com o
 *   trecho mais recente do raciocínio quando o texto chega;
 * - fora disso, "último sinal há Xs" (liveness.ts): o intervalo em que o silêncio
 *   é suspeito; passados 20 s sem sinal, fica na cor de aviso;
 * - esperando o usuário (permissão/pergunta): diz isso, sem shimmer nem sinal.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { summarizeActivity } from '../central/activitySummary'
import { COMPACTING_LABEL } from '@shared/compacting'
import { liveness } from '../liveness'
import { ChatLoader, useVisiblePause } from './ChatLoader'

interface Loose {
  kind?: string
  name?: string
  input?: unknown
  result?: unknown
  parentToolUseId?: string | null
  injected?: boolean
  ts?: number
  text?: string
}

export type LiveWaiting = 'permission' | 'question' | null

/** Sem sinal por tanto tempo (sem ferramenta nem raciocínio aberto), o "último sinal" fica na cor de aviso. */
export const QUIET_AFTER_MS = 20_000
/** Tamanho do trecho do raciocínio mostrado ao lado do "Pensando…". */
const DETAIL_MAX = 90

export const WAITING_LABEL: Record<Exclude<LiveWaiting, null>, string> = {
  permission: 'Aguardando sua permissão…',
  question: 'Aguardando sua resposta…'
}

const capital = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** As mensagens do turno atual: depois do último pedido do usuário (não injetado). */
function turnSlice(messages: readonly unknown[]): Loose[] {
  const list = messages as Loose[]
  let start = 0
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].kind === 'user' && !list[i].injected) {
      start = i + 1
      break
    }
  }
  return list.slice(start)
}

/** A ferramenta principal em andamento (sem resultado ainda) do turno, ou null. */
export function runningTool(messages: readonly unknown[]): Loose | null {
  const turn = turnSlice(messages)
  for (let i = turn.length - 1; i >= 0; i--) {
    const m = turn[i]
    if (m.kind === 'tool-use' && m.parentToolUseId == null) return m.result != null ? null : m
  }
  return null
}

/** O que o agente faz agora, no turno atual: a ferramenta principal em andamento
 *  (no vocabulário do activitySummary: "Lendo arquivo.ts", "Rodando npm test"…)
 *  ou "Pensando…" entre uma e outra. */
export function liveLabel(messages: readonly unknown[]): string {
  const tool = runningTool(messages)
  if (!tool) return 'Pensando…'
  const now = summarizeActivity([{ name: tool.name ?? '', input: tool.input, result: null }], { running: true }).now
  return now ? capital(now) : 'Pensando…'
}

/** O trecho mais recente do raciocínio: a última linha não vazia da última mensagem
 *  do turno, quando ela é um `thinking` com texto (streaming ou recém-fechado). */
export function thinkingDetail(messages: readonly unknown[], max = DETAIL_MAX): string | null {
  const turn = turnSlice(messages)
  const last = turn[turn.length - 1]
  if (!last || last.kind !== 'thinking' || typeof last.text !== 'string') return null
  const lines = last.text.split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines[lines.length - 1]
  if (!line) return null
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Hora da última mensagem do turno com `ts` (o reducer carimba as que chegam ao vivo). */
function lastMessageTs(messages: readonly unknown[]): number | undefined {
  const turn = turnSlice(messages)
  for (let i = turn.length - 1; i >= 0; i--) {
    const ts = turn[i].ts
    if (typeof ts === 'number') return ts
  }
  return undefined
}

/** Quando o turno começou: a hora do último pedido do usuário. */
function turnStart(messages: readonly unknown[]): number | null {
  const list = messages as Loose[]
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].kind === 'user' && !list[i].injected) return list[i].ts ?? null
  }
  return null
}

/** `m:ss`, ou `h:mm:ss` passando de uma hora. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/** "há 12 s" abaixo de um minuto; "há 1:05" daí em diante. */
export function sinceText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `há ${s} s` : `há ${elapsed(ms)}`
}

export interface ChatLiveProps {
  messages: readonly unknown[]
  /** Início da compactação em curso: vira "Compactando a conversa…". */
  compactingSince?: number
  /** A conversa: liga o "último sinal" e o raciocínio aberto (liveness.ts). Sem ela, só o rótulo e o tempo. */
  convId?: string
  /** O agente parou esperando o usuário (permissão ou pergunta). */
  waiting?: LiveWaiting
}

export function ChatLive({ messages, compactingSince, convId, waiting = null }: ChatLiveProps): JSX.Element {
  const compacting = compactingSince != null
  const activity = useMemo(() => liveLabel(messages), [messages])
  const tool = useMemo(() => runningTool(messages), [messages])
  const detail = useMemo(() => thinkingDetail(messages), [messages])
  const msgTs = useMemo(() => lastMessageTs(messages), [messages])
  const since = useMemo(() => turnStart(messages), [messages])
  const [mountedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const paused = useVisiblePause(rootRef)
  useEffect(() => {
    if (paused) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [paused])

  const from = compacting ? compactingSince : since
  const start = from != null && from <= now ? from : mountedAt
  const label = compacting ? COMPACTING_LABEL : waiting ? WAITING_LABEL[waiting] : activity
  // Lidos no tique (a store não é assinada): o raciocínio aberto e o último sinal.
  const thinkingSince = convId && !tool ? liveness.thinking(convId) : null
  const live = !compacting && !waiting
  // O tempo da atividade: a ferramenta rodando ou o raciocínio aberto.
  const activityAt = live ? (tool ? tool.ts : thinkingSince) ?? null : null
  const showDetail = live && !tool && !!detail
  // "Último sinal": só quando nada está visivelmente em andamento (ferramenta
  // ou raciocínio): é aí que o silêncio é suspeito.
  const signalAt = live && convId && !tool && thinkingSince == null ? Math.max(liveness.get(convId) ?? 0, msgTs ?? 0) || undefined : undefined
  const quiet = signalAt != null && now - signalAt >= QUIET_AFTER_MS

  const cls = ['chat-live', compacting && 'compacting', waiting && 'waiting'].filter(Boolean).join(' ')
  const aria = compacting ? 'Compactando a conversa' : waiting ? `Agente esperando: ${label}` : `Agente trabalhando: ${label}`
  return (
    <div ref={rootRef} className={cls} role="status" aria-label={aria} data-paused={paused ? '' : undefined}>
      <ChatLoader compacting={compacting} />
      {/* A chave troca com a ação: o texto novo entra com um fade curto. */}
      <span key={label} className="chat-live-text">
        {label}
      </span>
      {activityAt != null && activityAt <= now && <span className="chat-live-elapsed">há {elapsed(now - activityAt)}</span>}
      {showDetail && <span className="chat-live-detail">{detail}</span>}
      {signalAt != null && <span className={quiet ? 'chat-live-signal quiet' : 'chat-live-signal'}>último sinal {sinceText(now - signalAt)}</span>}
      <span className="chat-live-time">{elapsed(now - start)}</span>
    </div>
  )
}
