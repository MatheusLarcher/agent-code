/**
 * A barrinha de consumo do chat flutuante do Escritório (a flag `usageMini` do
 * ChatDisplayContext): no lugar do medidor do cabeçalho (tempo, entrada, saída,
 * custo) e do aviso do Controle do Windows, só uma barra fina FATIADA por tipo de
 * consumo de tokens — Entrada, Cache lido, Cache escrito e Saída —, cada fatia
 * do tamanho do que ela consumiu na conversa.
 *
 *   passar o mouse   (ou focar) o cartão: o que é cada fatia, o número exato e
 *                    a parte do total; o contexto agora contra o limite do
 *                    modelo (a barra ganha o anel âmbar/vermelho perto do
 *                    limite); o tempo da tarefa; o custo da conversa e o da
 *                    última resposta
 *   clicar           abre o painel por agente e subagente (TokenUsagePanel); o
 *                    cartão sai enquanto ele está aberto. Esc fecha o cartão
 *
 * Os números vêm do histórico do banco e do ao vivo, sem contar duas vezes
 * (useTokenUsageTotals); o contexto e o custo, do `tokens` da conversa.
 */
import { useEffect, useId, useState } from 'react'
import { contextLimitFor, type TurnTimeTotals } from '@shared/ipc'
import { fmtCost, fmtShare, fmtTokens, tokenCount, usageSlices } from '../tokenUsageHistory'
import type { UsageMap } from '../tokenUsageTree'
import { fmtDuration } from './fmtDuration'
import { useTokenUsageTotals } from './useTokenUsageTotals'
import './usageMini.css'

export interface UsageMiniBarProps {
  convId: string | null
  tokens: { context: number; output: number; cost: number; lastOutput?: number; lastCost?: number }
  usageMap: UsageMap
  /** O modelo em que o turno roda: o limite da janela de contexto vem dele. */
  model: string
  runningSince: number | null
  lastDurationMs: number | null
  /** Tempo somado dos turnos já terminados (`null` até a primeira leitura). */
  timeTotals: TurnTimeTotals | null
  /** O painel por agente e subagente está aberto (o clique o abre e fecha). */
  open: boolean
  onToggle: () => void
}

type Level = 'ok' | 'warn' | 'crit'
const levelOf = (pct: number): Level => (pct >= 95 ? 'crit' : pct >= 80 ? 'warn' : 'ok')

/** O tempo da tarefa; o relógio só corre com o cartão à vista. */
function Elapsed({ since, lastMs }: { since: number | null; lastMs: number | null }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since == null) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [since])
  if (since != null) {
    return (
      <>
        <b>⏱ {fmtDuration(Math.max(0, now - since))}</b> <small>em execução</small>
      </>
    )
  }
  if (lastMs != null) {
    return (
      <>
        <b>⏱ {fmtDuration(lastMs)}</b> <small>última tarefa</small>
      </>
    )
  }
  return <b>—</b>
}

export function UsageMiniBar({ convId, tokens, usageMap, model, runningSince, lastDurationMs, timeTotals, open, onToggle }: UsageMiniBarProps): JSX.Element {
  const popId = useId()
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  // Esc fecha o cartão até o mouse (ou o foco) sair e voltar.
  const [dismissed, setDismissed] = useState(false)
  const totals = useTokenUsageTotals(convId, usageMap)
  const slices = usageSlices(totals.tokens)
  const total = tokenCount(totals.tokens)
  const limit = contextLimitFor(model)
  const ctxPct = Math.min(100, limit > 0 ? (tokens.context / limit) * 100 : 0)
  const level = levelOf(ctxPct)
  const show = (hover || focus) && !open && !dismissed

  return (
    <div
      className={`um${open ? ' open' : ''}${runningSince != null ? ' running' : ''}`}
      data-testid="usage-mini"
      data-level={level}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false)
        setDismissed(false)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !show) return
        e.stopPropagation()
        setDismissed(true)
      }}
    >
      <button
        type="button"
        className="um-bar"
        aria-expanded={open}
        aria-describedby={show ? popId : undefined}
        aria-label={`Consumo de tokens: ${fmtTokens(total)} no total, contexto em ${Math.round(ctxPct)}%, ${fmtCost(tokens.cost)}. ${open ? 'Clique para esconder' : 'Clique para detalhar'} por agente e subagente.`}
        onClick={onToggle}
        onFocus={() => setFocus(true)}
        onBlur={() => {
          setFocus(false)
          setDismissed(false)
        }}
      >
        <span className={`um-track${total > 0 ? '' : ' um-none'}`} aria-hidden="true">
          {slices
            .filter((s) => s.tokens > 0)
            .map((s) => (
              <span key={s.key} className={`um-slice um-${s.key}`} style={{ flexGrow: s.tokens }} />
            ))}
        </span>
      </button>
      {show && (
        <div className="um-pop" id={popId} role="tooltip">
          <div className="um-card">
            <div className="um-head">
              <strong>Consumo desta conversa</strong>
              <span>
                {totals.calls} {totals.calls === 1 ? 'chamada' : 'chamadas'}
              </span>
            </div>
            {total > 0 ? (
              <ul className="um-legend">
                {slices.map((s) => (
                  <li key={s.key} className={s.tokens > 0 ? undefined : 'um-zero'}>
                    <i className={`um-sw um-${s.key}`} aria-hidden="true" />
                    <span className="um-name">{s.label}</span>
                    <b className="um-num">{fmtTokens(s.tokens)}</b>
                    <span className="um-pct">{fmtShare(s.share)}</span>
                    <small className="um-what">{s.what}</small>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="um-empty">Nenhum consumo ainda nesta conversa.</p>
            )}
            <div className="um-ctx" data-level={level}>
              <span>Contexto agora</span>
              <b>
                {fmtTokens(tokens.context)} / {fmtTokens(limit)}
              </b>
              <span className="um-pct">{ctxPct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%</span>
              <span className="um-ctx-track" aria-hidden="true">
                <span style={{ width: `${ctxPct}%` }} />
              </span>
            </div>
            <dl className="um-foot">
              <dt>Tempo</dt>
              <dd>
                <Elapsed since={runningSince} lastMs={lastDurationMs} />
                {timeTotals && timeTotals.turns > 0 && (
                  <small>
                    {' '}
                    · {fmtDuration(timeTotals.totalMs)} no total ({timeTotals.turns} {timeTotals.turns === 1 ? 'tarefa' : 'tarefas'})
                  </small>
                )}
              </dd>
              <dt>Custo</dt>
              <dd>
                <b>{fmtCost(tokens.cost)}</b> <small>nesta conversa</small>
              </dd>
              {tokens.lastCost !== undefined && (
                <>
                  <dt>Última resposta</dt>
                  <dd>
                    <b>{fmtCost(tokens.lastCost)}</b>
                    {tokens.lastOutput !== undefined && <small> · {fmtTokens(tokens.lastOutput)} tokens de saída</small>}
                  </dd>
                </>
              )}
            </dl>
            <p className="um-hint">Clique para ver por agente e subagente</p>
          </div>
        </div>
      )}
    </div>
  )
}
