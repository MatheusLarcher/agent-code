/**
 * O turno do agente no chat do celular (o visual aprovado em
 * docs/spec/chat-visual-20261007): avatar ✦ + "Agent" no topo e um trilho vertical
 * com um ponto por item — narração, linha-resumo dos passos, pensamento — na ordem
 * em que aconteceram. Com o turno rodando, a última linha é a "ao vivo": ponto
 * pulsando no trilho, o que o agente faz agora (brilho correndo), o tempo do turno e
 * o "■ parar" — o único status do turno (não há mais a faixa "trabalhando…" embaixo).
 */
import type { ReactNode } from 'react'
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
  return k === 'user' || k === 'system' || k === 'status' || k === 'provider-switch' || k === 'account-switch'
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

export interface Live {
  text: string
  /** Início do turno (o tempo ao lado). */
  since?: number
  /** O turno emudeceu desde então: "Sem resposta há Xs" no lugar do texto. */
  stalledSince?: number
}

/** O único status do turno: o que faz agora (ou "sem resposta há…"), o tempo e o "■ parar". */
function LiveRow({ text, since, stalledSince }: Live): JSX.Element {
  const now = useTick(!!since || !!stalledSince)
  const stop = (): void => {
    client.interrupt().catch((err) => toast('Não consegui parar: ' + errorText(err)))
  }
  return (
    <div className={`turn-item live${stalledSince ? ' stalled' : ''}`} aria-live="polite">
      <div className="live-row">
        {stalledSince ? <span className="live-stalled">Sem resposta há {fmtElapsed(stalledSince, now)}</span> : <span className="shimmer">{text}</span>}
        {since && !stalledSince ? <span className="live-t">{fmtElapsed(since, now)}</span> : null}
        <button type="button" className="live-stop" title="Parar o turno" aria-label="Parar" onClick={stop}>
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
