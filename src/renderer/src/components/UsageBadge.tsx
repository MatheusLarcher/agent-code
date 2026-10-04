import { useEffect, useRef, useState } from 'react'
import { usageProviderOf, type RateLimitStatus, type UsageProvider } from '@shared/ipc'
import { IconChevronDown } from './Icons'

/** Portuguese label + display order for each Anthropic rate-limit window.
 *  Order matters: the 5h session comes first (most actionable), then the
 *  weekly windows, then overage. GPT windows are labelled from their real
 *  length (`windowMinutes`) — see `gptLabel`. */
const LABELS: Record<RateLimitStatus['rateLimitType'], string> = {
  five_hour: 'Sessão 5h',
  seven_day: 'Semana',
  seven_day_opus: 'Semana · Opus',
  seven_day_sonnet: 'Semana · Sonnet',
  seven_day_overage_included: 'Semana (excedente incluso)',
  overage: 'Excedente',
  gpt_primary: 'Sessão',
  gpt_secondary: 'Semana'
}
const ORDER: RateLimitStatus['rateLimitType'][] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
  'gpt_primary',
  'gpt_secondary'
]

/** What each window actually means — shown in the tooltip so hovering explains
 *  the CONCEPT (account-wide, shared across every app), not just the %. */
const EXPLAIN: Record<RateLimitStatus['rateLimitType'], string> = {
  five_hour:
    'Janela de 5 horas da sua CONTA Anthropic (Pro/Max) — reseta a cada 5h corridas. ' +
    'Soma o uso em TODOS os apps com a mesma conta: Claude Desktop, claude.ai, Claude Code e este app. ' +
    'Não é desta conversa nem deste app sozinho.',
  seven_day:
    'Limite semanal (7 dias) da sua CONTA Anthropic — mesma ideia da janela de 5h, só que numa janela maior. ' +
    'Soma o uso em TODOS os apps com a mesma conta: Claude Desktop, claude.ai, Claude Code e este app.',
  seven_day_opus: 'Limite semanal (7 dias) específico do modelo Opus, na sua CONTA Anthropic — soma todos os apps.',
  seven_day_sonnet: 'Limite semanal (7 dias) específico do modelo Sonnet, na sua CONTA Anthropic — soma todos os apps.',
  seven_day_overage_included:
    'Limite semanal (7 dias) da sua CONTA Anthropic, já contando o excedente pago incluso — soma todos os apps.',
  overage: 'Excedente pago além do seu plano, na sua CONTA Anthropic.',
  gpt_primary:
    'Janela curta da sua ASSINATURA ChatGPT (Plus/Pro/Team). ' +
    'Soma o uso em todos os apps com a mesma conta: ChatGPT, Codex e este app. Não é desta conversa.',
  gpt_secondary:
    'Janela longa (semanal) da sua ASSINATURA ChatGPT. ' +
    'Soma o uso em todos os apps com a mesma conta: ChatGPT, Codex e este app.'
}

const PROVIDER_LABEL: Record<UsageProvider, string> = { claude: 'Claude', gpt: 'GPT' }
const PROVIDER_ORDER: UsageProvider[] = ['claude', 'gpt']

function fmtResetsAt(ms: number): string {
  const diff = ms - Date.now()
  if (diff <= 0) return 'já resetou'
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return `reseta em ${mins}min`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `reseta em ${hours}h`
  return `reseta em ${Math.round(hours / 24)}d`
}

/** GPT windows are named by length, because the backend only says
 *  "primary"/"secondary" and the lengths may change per plan. */
function gptLabel(limit: RateLimitStatus): string {
  const m = limit.windowMinutes
  if (!m) return LABELS[limit.rateLimitType]
  if (m % (24 * 60) === 0) {
    const days = m / (24 * 60)
    return days === 7 ? 'Semana' : `${days} dias`
  }
  if (m % 60 === 0) return `Sessão ${m / 60}h`
  return `Sessão ${m}min`
}

function labelOf(limit: RateLimitStatus): string {
  return usageProviderOf(limit.rateLimitType) === 'gpt' ? gptLabel(limit) : LABELS[limit.rateLimitType]
}

type Level = 'ok' | 'warn' | 'crit'
const pctOf = (limit: RateLimitStatus): number => Math.min(100, (limit.utilization ?? 0) * 100)
function levelOf(limit: RateLimitStatus): Level {
  const pct = pctOf(limit)
  return limit.status === 'rejected' || pct >= 95 ? 'crit' : limit.status === 'allowed_warning' || pct >= 80 ? 'warn' : 'ok'
}

/** One window's usage pill — same visual language as ChatPanel's ContextBar
 *  (`.ctx-bar*` classes). Used in the expanded panel; the reset time sits
 *  beside it, and the hover tooltip explains the concept. */
export function UsagePill({ limit }: { limit: RateLimitStatus }): JSX.Element {
  const pct = pctOf(limit)
  const level = levelOf(limit)
  const label = labelOf(limit)
  const resetText = limit.resetsAt ? fmtResetsAt(limit.resetsAt) : ''
  const resetHint = resetText ? ` — ${resetText}` : ''
  return (
    <div className="usage-item">
      <div
        className={`ctx-bar usage-pill ${level}`}
        title={`${EXPLAIN[limit.rateLimitType]} ${pct.toFixed(0)}% usado${resetHint}.`}
      >
        <span className="ctx-bar-cap">{label}</span>
        <span className="ctx-bar-track">
          <span className="ctx-bar-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="ctx-bar-val">{pct.toFixed(0)}%</span>
      </div>
      {resetText && <span className="usage-reset">{resetText}</span>}
    </div>
  )
}

const SESSION_TYPES: RateLimitStatus['rateLimitType'][] = ['five_hour', 'gpt_primary']
const WEEKLY_TYPES: RateLimitStatus['rateLimitType'][] = [
  'seven_day',
  'gpt_secondary',
  'seven_day_overage_included',
  'seven_day_opus',
  'seven_day_sonnet'
]
const pick = (limits: RateLimitStatus[], types: RateLimitStatus['rateLimitType'][]): RateLimitStatus | undefined =>
  types.map((t) => limits.find((l) => l.rateLimitType === t)).find(Boolean)

function Arc({ r, limit }: { r: number; limit?: RateLimitStatus }): JSX.Element {
  return (
    <>
      <circle className="usage-ring-track" cx="14" cy="14" r={r} />
      {limit && (
        <circle
          className={`usage-ring-arc ${levelOf(limit)}`}
          cx="14"
          cy="14"
          r={r}
          pathLength={100}
          strokeDasharray={`${pctOf(limit)} 100`}
        />
      )}
    </>
  )
}

/** Compact usage for one subscription/account: a double ring — outer = the
 *  short session window (5h), inner = the weekly one. Hovering shows every
 *  window's % and reset; the full panel stays behind the chevron. */
export function UsageRing({ name, initial, limits }: { name: string; initial: string; limits: RateLimitStatus[] }): JSX.Element {
  const session = pick(limits, SESSION_TYPES)
  const weekly = pick(limits, WEEKLY_TYPES)
  const worst = limits.some((l) => levelOf(l) === 'crit') ? 'crit' : limits.some((l) => levelOf(l) === 'warn') ? 'warn' : 'ok'
  const summary = limits.map((l) => `${labelOf(l)} ${pctOf(l).toFixed(0)}%`).join(', ')
  return (
    <div className={`usage-ring ${worst}`} tabIndex={0} role="img" aria-label={`${name}: ${summary}`}>
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <Arc r={12} limit={session} />
        <Arc r={8} limit={weekly} />
        <text x="14" y="14" className="usage-ring-initial">
          {initial}
        </text>
      </svg>
      <div className="usage-ring-tip" aria-hidden="true">
        <strong>{name}</strong>
        {limits.map((l) => (
          <div className={`usage-ring-row ${levelOf(l)}`} key={l.rateLimitType}>
            <span>{labelOf(l)}</span>
            <b>{pctOf(l).toFixed(0)}%</b>
            <small>{l.resetsAt ? fmtResetsAt(l.resetsAt) : ''}</small>
          </div>
        ))}
      </div>
    </div>
  )
}

export type UsageProviders = Record<UsageProvider, boolean>
const ALL_PROVIDERS: UsageProviders = { claude: true, gpt: true }

interface Props {
  limits: Record<string, RateLimitStatus>
  /** Which subscriptions the compact bar shows. Defaults to both. */
  providers?: UsageProviders
  onProvidersChange?: (next: UsageProviders) => void
}

/** Account-wide usage (5h session / weekly / etc.), shown in the topbar — NOT
 *  tied to the active conversation (unlike ContextBar). Groups the windows by
 *  subscription (Claude vs GPT). The compact bar shows only the subscriptions
 *  the user ticked; a discreet chevron opens a panel with every subscription,
 *  its windows and the "mostrar na barra" toggles. Renders nothing until at
 *  least one snapshot exists; API-key-only accounts never trigger any, so the
 *  badge silently stays hidden instead of showing a misleading empty bar. */
export function UsageBadge({ limits, providers = ALL_PROVIDERS, onProvidersChange }: Props): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const present = ORDER.map((t) => limits[t]).filter((l): l is RateLimitStatus => !!l)
  if (present.length === 0) return null

  const byProvider = (p: UsageProvider): RateLimitStatus[] =>
    present.filter((l) => usageProviderOf(l.rateLimitType) === p)
  const shown = PROVIDER_ORDER.filter((p) => providers[p] && byProvider(p).length > 0)
  const toggle = (p: UsageProvider): void => onProvidersChange?.({ ...providers, [p]: !providers[p] })

  return (
    <div className={`usage-badge${open ? ' open' : ''}`} ref={rootRef}>
      {shown.map((p) => (
        <UsageRing key={p} name={PROVIDER_LABEL[p]} initial={PROVIDER_LABEL[p][0]} limits={byProvider(p)} />
      ))}
      {shown.length === 0 && <span className="usage-provider muted">Uso</span>}
      <button
        type="button"
        className="usage-expand"
        onClick={() => setOpen((v) => !v)}
        title="Ver o consumo de todas as assinaturas"
        aria-expanded={open}
        aria-label="Detalhar consumo"
      >
        <IconChevronDown size={13} />
      </button>
      {open && (
        <div className="usage-popover" role="dialog" aria-label="Consumo das assinaturas">
          {PROVIDER_ORDER.map((p) => {
            const items = byProvider(p)
            return (
              <section className="usage-popover-section" key={p}>
                <label className="usage-popover-head">
                  <input type="checkbox" checked={providers[p]} onChange={() => toggle(p)} />
                  <strong>{PROVIDER_LABEL[p]}</strong>
                  <span className="usage-popover-hint">mostrar na barra</span>
                </label>
                {items.length > 0 ? (
                  <div className="usage-popover-items">
                    {items.map((l) => (
                      <UsagePill key={l.rateLimitType} limit={l} />
                    ))}
                  </div>
                ) : (
                  <span className="usage-popover-empty">
                    {p === 'gpt'
                      ? 'Sem dados ainda — use um modelo GPT com a conta ChatGPT conectada.'
                      : 'Sem dados ainda — use um modelo Claude com assinatura Pro/Max.'}
                  </span>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
