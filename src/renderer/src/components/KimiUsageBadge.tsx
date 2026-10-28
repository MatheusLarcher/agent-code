import { useEffect, useState } from 'react'
import type { KimiUsage, KimiUsageWindow } from '@shared/ipc'
import { fmtResetsAt } from './UsageBadge'

/** 262144 → "256K", 1048576 → "1M" (janelas do Kimi são potências de 2). */
export function windowLabel(tokens: number): string {
  if (tokens >= 1_048_576) return `${Math.round(tokens / 1_048_576)}M`
  return `${Math.round(tokens / 1024)}K`
}

/** De quanto em quanto tempo a bolinha relê o uso no Kimi. */
const REFRESH_MS = 2 * 60_000

type Level = 'ok' | 'warn' | 'crit'
const pctOf = (w: KimiUsageWindow): number => Math.min(100, w.usedRatio * 100)
const levelOf = (w: KimiUsageWindow): Level => (pctOf(w) >= 95 ? 'crit' : pctOf(w) >= 80 ? 'warn' : 'ok')

function Arc({ r, w }: { r: number; w?: KimiUsageWindow }): JSX.Element {
  return (
    <>
      <circle className="usage-ring-track" cx="14" cy="14" r={r} />
      {w && (
        <circle
          className={`usage-ring-arc ${levelOf(w)}`}
          cx="14"
          cy="14"
          r={r}
          pathLength={100}
          strokeDasharray={`${pctOf(w)} 100`}
        />
      )}
    </>
  )
}

interface Props {
  /** Janela detectada no "Testar conexão" (config.kimi.contextWindow). */
  contextWindow?: number
  /** Leitura do uso (testes injetam; padrão = IPC do main). */
  load?: () => Promise<KimiUsage | null>
}

/** Uso da assinatura do Kimi Code na barra de cima, no mesmo anel duplo do
 *  Claude: anel de fora = janela de 5h, de dentro = mês. Sem leitura (sem
 *  chave, offline), cai no rótulo "Kimi · assinatura". */
export function KimiUsageBadge({ contextWindow, load = () => window.api.kimiUsage() }: Props): JSX.Element {
  const [usage, setUsage] = useState<KimiUsage | null>(null)

  useEffect(() => {
    let alive = true
    const tick = (): void => {
      load()
        .then((u) => alive && setUsage(u))
        .catch(() => undefined)
    }
    tick()
    const id = setInterval(tick, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const janela = contextWindow ? ` · janela ${windowLabel(contextWindow)}` : ''
  if (!usage) {
    return (
      <div
        className="usage-badge deepseek-usage kimi-usage"
        title="Conversa no Kimi Code, pela sua assinatura: sem cobrança por token."
      >
        <span className="usage-provider muted">{`Kimi · assinatura${janela}`}</span>
      </div>
    )
  }

  const rows: Array<[string, KimiUsageWindow | undefined]> = [
    ['Sessão 5h', usage.session],
    ['Mês', usage.month]
  ]
  const present = rows.filter((r): r is [string, KimiUsageWindow] => !!r[1])
  const worst: Level = present.some(([, w]) => levelOf(w) === 'crit') ? 'crit' : present.some(([, w]) => levelOf(w) === 'warn') ? 'warn' : 'ok'
  const summary = present.map(([l, w]) => `${l} ${pctOf(w).toFixed(0)}%`).join(', ')
  return (
    <div className="usage-badge kimi-usage">
      <div className={`usage-ring ${worst}`} tabIndex={0} role="img" aria-label={`Kimi: ${summary}`}>
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
          <Arc r={12} w={usage.session} />
          <Arc r={8} w={usage.month} />
          <text x="14" y="14" className="usage-ring-initial">
            K
          </text>
        </svg>
        <div className="usage-ring-tip" aria-hidden="true">
          <strong>{`Kimi · assinatura${janela}`}</strong>
          {present.map(([l, w]) => (
            <div className={`usage-ring-row ${levelOf(w)}`} key={l}>
              <span>{l}</span>
              <b>{pctOf(w).toFixed(0)}%</b>
              <small>{w.resetsAt ? fmtResetsAt(w.resetsAt) : ''}</small>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
