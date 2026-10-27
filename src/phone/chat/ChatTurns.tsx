/**
 * O turno do agente no chat do celular (o visual aprovado em
 * docs/spec/chat-visual-20261007): avatar ✦ + "Agent" no topo e um trilho vertical
 * com um ponto por item — narração, linha-resumo dos passos, pensamento — na ordem
 * em que aconteceram. Com o turno rodando, a última linha é a "ao vivo": o loading
 * (ChatLoader) no trilho, o que o agente faz agora (brilho correndo), o tempo do turno e
 * o "■ parar" — o único status do turno (não há mais a faixa "trabalhando…" embaixo).
 */
import type { ReactNode } from 'react'
import { apiRetryText, type ApiRetryState } from '@shared/apiRetry'
import { COMPACTING_LABEL } from '@shared/compacting'
import { ChatLoader } from '@renderer/components/ChatLoader'
import { stepActivity, type ChatRowItem } from '@renderer/components/chatSteps'
import { client, toast } from '../app/runtime'
import { fmtElapsed } from '../core/format'
import { errorText } from '../core/net'
import type { ChatMsg } from '../core/types'
import { useTick } from './ChatBars'

export type Row = ChatRowItem<ChatMsg>
export type Block = { kind: 'row'; key: string; row: Row } | { kind: 'turn'; key: string; rows: Row[] }

/** Fora do trilho: a sua mensagem e os avisos da sessão (centralizados). */
function standsAlone(r: Row): boolean {
  if (r.type !== 'msg') return false
  const k = r.msg.kind
  return k === 'user' || k === 'system' || k === 'status' || k === 'provider-switch' || k === 'account-switch' || k === 'tarefa-aviso'
}

/**
 * As linhas em blocos: cada sequência de linhas do agente vira UM turno. A chave do
 * turno vem da linha que o precede (não da 1ª dele), para o turno que nasce só com
 * a linha "ao vivo" não remontar quando chega a 1ª resposta.
 */
export function groupTurns(rows: readonly Row[], live: boolean): Block[] {
  const blocks: Block[] = []
  let prev = 'start'
  for (const r of rows) {
    if (standsAlone(r)) {
      blocks.push({ kind: 'row', key: r.key, row: r })
      prev = r.key
      continue
    }
    const last = blocks[blocks.length - 1]
    if (last?.kind === 'turn') last.rows.push(r)
    else blocks.push({ kind: 'turn', key: `turn:${prev}`, rows: [r] })
  }
  if (live && blocks[blocks.length - 1]?.kind !== 'turn') blocks.push({ kind: 'turn', key: `turn:${prev}`, rows: [] })
  return blocks
}

/** O que o agente faz agora: o "agora: …" da resposta que roda, ou um genérico. */
export function liveText(rows: readonly Row[]): string {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.type === 'step' && r.running) {
      const now = stepActivity(r).now
      if (now) return now.charAt(0).toUpperCase() + now.slice(1)
      break
    }
  }
  return 'Trabalhando…'
}

/** Início do turno em andamento: a hora da última mensagem sua. */
export function turnStart(rows: readonly Row[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.type === 'msg' && r.msg.kind === 'user') return r.msg.ts || undefined
  }
  return undefined
}

/** O fim do turno em andamento: a última mensagem, a ferramenta que roda e quando chegou o último pedaço. */
export interface TurnTail {
  /** A última mensagem do turno (texto, pensamento ou ferramenta), se houver. */
  last?: ChatMsg
  /** Quando chegou a última mensagem do turno (o maior `ts` da última linha). */
  lastTs?: number
  /** A ferramenta principal em andamento (sem resultado): quando foi chamada. */
  toolSince?: number
}

export function turnTail(rows: readonly Row[]): TurnTail {
  const r = rows[rows.length - 1]
  if (!r) return {}
  if (r.type === 'msg') return { last: r.msg, lastTs: r.msg.ts || undefined }
  const all = r.text ? [r.text, ...r.items] : r.items
  const last = all[all.length - 1]
  let lastTs = 0
  for (const m of all) if (m.ts && m.ts > lastTs) lastTs = m.ts
  let toolSince: number | undefined
  if (r.running) {
    const t = r.tools[r.tools.length - 1]
    if (t && t.kind === 'tool-use' && !t.result) toolSince = t.ts || undefined
  }
  return { last, lastTs: lastTs || undefined, toolSince }
}

/** O detalhe da linha ao vivo: com o genérico "Trabalhando…" (ou "Pensando…"), a última linha do pensamento que chega. */
export function liveDetail(text: string, last: ChatMsg | undefined, max = 90): string | undefined {
  if ((text !== 'Trabalhando…' && text !== 'Pensando…') || !last || last.kind !== 'thinking' || !last.text) return undefined
  const lines = last.text.split('\n').map((l) => l.trim()).filter(Boolean)
  const line = lines[lines.length - 1]
  if (!line) return undefined
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** "há 12 s" até 1 min; depois "há 1:05". */
export function fmtAgo(since: number, now = Date.now(), clock = false): string {
  const s = Math.max(0, Math.round((now - since) / 1000))
  if (s < 60 && !clock) return `há ${s} s`
  return `há ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Sem sinal há tanto tempo a linha fica em alerta. */
export const QUIET_AFTER_MS = 20_000

export interface Live {
  text: string
  /** Uma linha discreta ao lado do texto (a última linha do pensamento, com o genérico). */
  detail?: string
  /** Início do turno (o tempo ao lado). */
  since?: number
  /** Último sinal do CLI (heartbeat ou saída): "último sinal há Xs". Ausente = não mostra. */
  lastSignalAt?: number
  /** A ferramenta principal em andamento: "há M:SS" dela (o sinal some). */
  toolSince?: number
  /** Bloco de raciocínio aberto (heartbeat): "Pensando…" com "há M:SS" (o sinal some); a ferramenta vence. */
  thinkingSince?: number
  /** O turno espera por você: permissão ou resposta a uma pergunta. */
  waiting?: 'permission' | 'question' | null
  /** O turno emudeceu desde então: "Sem resposta há Xs" no lugar do texto. */
  stalledSince?: number
  /** A conversa está sendo compactada desde então: "Compactando a conversa…" e o tempo dela. */
  compactingSince?: number
  /** Nova tentativa da API agendada pelo CLI: o motivo e quanto falta (vence o compactando). */
  apiRetry?: ApiRetryState
}

/**
 * O único status do turno: o loading no trilho (ChatLoader, o mesmo do PC), o que
 * faz agora (ou a nova tentativa da API, ou "Compactando a conversa…", ou "sem
 * resposta há…", ou "Aguardando sua permissão…"), o detalhe, o último sinal (ou o
 * tempo da ferramenta que roda), o tempo do turno e o "■ parar".
 */
export function LiveRow({ text, detail, since, lastSignalAt, toolSince, thinkingSince, waiting, stalledSince, compactingSince, apiRetry }: Live): JSX.Element {
  const now = useTick(!!since || !!stalledSince || !!compactingSince || !!apiRetry || !!lastSignalAt || !!toolSince || !!thinkingSince)
  const stop = (): void => {
    client.interrupt().catch((err) => toast('Não consegui parar: ' + errorText(err)))
  }
  const retrying = !stalledSince && !!apiRetry
  const compacting = !stalledSince && !retrying && !!compactingSince
  const plain = !stalledSince && !retrying && !compacting
  const clock = compacting ? compactingSince : since
  // Atividade com tempo próprio: a ferramenta que roda ou o raciocínio aberto (a ferramenta vence).
  const activity = toolSince || thinkingSince
  const label = !toolSince && thinkingSince ? 'Pensando…' : text
  const quiet = plain && !waiting && !activity && !!lastSignalAt && now - lastSignalAt > QUIET_AFTER_MS
  const cls = `turn-item live${stalledSince ? ' stalled' : ''}${retrying ? ' retrying' : ''}${compacting ? ' compacting' : ''}${waiting ? ' waiting' : ''}${quiet ? ' quiet' : ''}`
  return (
    <div className={cls} aria-live="polite">
      <ChatLoader compacting={compacting} className="live-loader" />
      <div className="live-row">
        {stalledSince ? (
          <span className="live-stalled">Sem resposta há {fmtElapsed(stalledSince, now)}</span>
        ) : retrying && apiRetry ? (
          <span className="live-retry">{apiRetryText(apiRetry, now)}</span>
        ) : compacting ? (
          <span className="live-compacting">{COMPACTING_LABEL}</span>
        ) : waiting ? (
          <span className="live-waiting">{waiting === 'question' ? 'Aguardando sua resposta…' : 'Aguardando sua permissão…'}</span>
        ) : (
          <>
            <span className="shimmer">{label}</span>
            {detail ? <span className="live-detail">{detail}</span> : null}
            {activity ? (
              <span className="live-tool">{fmtAgo(activity, now, true)}</span>
            ) : lastSignalAt ? (
              <span className={`live-signal${quiet ? ' quiet' : ''}`}>último sinal {fmtAgo(lastSignalAt, now)}</span>
            ) : null}
          </>
        )}
        {clock && !stalledSince && !retrying ? <span className="live-t">{fmtElapsed(clock, now)}</span> : null}
        <button type="button" className="live-stop" aria-label="Parar" onClick={stop}>
          ■ parar
        </button>
      </div>
    </div>
  )
}

export function Turn({ rows, model, live, isFresh, renderRow }: {
  rows: Row[]
  model?: string
  /** O turno roda: a linha "ao vivo" no fim. */
  live: Live | null
  isFresh: (key: string) => boolean
  renderRow: (r: Row, fresh: boolean) => ReactNode
}): JSX.Element {
  return (
    <div className="turn">
      <div className="turn-head">
        <span className="turn-avatar" aria-hidden="true">✦</span>
        <b>Agent</b>
        {model && <span className="turn-model">{model}</span>}
      </div>
      <div className="turn-rail">
        {rows.map((r) => {
          const fresh = isFresh(r.key)
          return (
            <div key={r.key} className={`turn-item${fresh ? ' pop' : ''}`}>
              {renderRow(r, fresh)}
            </div>
          )
        })}
        {live && <LiveRow {...live} />}
      </div>
    </div>
  )
}
