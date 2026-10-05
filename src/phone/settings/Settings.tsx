/** Configurações: Permitir tudo, uso da conta e contexto, Voz no aparelho e a conexão (sair). */
import { useEffect } from 'react'
import { client, nav } from '../app/runtime'
import { fmtReset, fmtTokens, USAGE_LABELS } from '../core/format'
import { useStore } from '../core/store'
import { confirmExit } from '../shell/StatusMenu'
import { Icon } from '../ui/icons'
import { VoiceCard } from './VoiceCard'

function UsageRow({ label, pct, detail }: { label: string; pct: number; detail: string }): JSX.Element {
  return (
    <div className="usage-row">
      <div className="usage-label">{label}</div>
      <div className="usage-track">
        <div className={`usage-fill${pct >= 95 ? ' crit' : pct >= 80 ? ' warn' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="usage-detail">{detail}</div>
    </div>
  )
}

function UsageCard(): JSX.Element {
  const usage = useStore(client.store, (s) => s.usage)
  const tokens = useStore(client.store, (s) => s.conversations.find((c) => c.id === s.convId)?.tokens)
  const rows: JSX.Element[] = []
  if (tokens) {
    const pct = tokens.contextLimit ? Math.min(100, Math.round((tokens.context / tokens.contextLimit) * 100)) : 0
    rows.push(
      <UsageRow
        key="ctx"
        label="Contexto desta conversa"
        pct={pct}
        detail={`${fmtTokens(tokens.context)} / ${fmtTokens(tokens.contextLimit)} · ↑ ${fmtTokens(tokens.output)} saída${tokens.cost ? ` · ~$${tokens.cost.toFixed(2)}` : ''}`}
      />
    )
  }
  for (const [k, u] of Object.entries(usage)) {
    const pct = Math.round((u.utilization || 0) * 100)
    rows.push(<UsageRow key={k} label={USAGE_LABELS[k] || k} pct={pct} detail={`${pct}% usado${u.resetsAt ? ` · ${fmtReset(u.resetsAt)}` : ''}`} />)
  }
  return (
    <section className="cfg-card">
      <div className="cfg-card-title">Uso da conta e contexto</div>
      <div className="cfg-usage">{rows.length ? rows : <span className="cfg-desc">Sem dados de uso ainda.</span>}</div>
    </section>
  )
}

export function Settings(): JSX.Element | null {
  const open = useStore(nav, (s) => s.settingsOpen)
  const skip = useStore(client.store, (s) => s.skipPerms)
  const base = useStore(client.store, (s) => s.base)
  const token = useStore(client.store, (s) => s.token)
  const close = (): void => nav.set({ settingsOpen: false })

  // Voltar do Android fecha as Configurações em vez de sair do app.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null
  return (
    <aside className="settings-panel">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="Voltar" onClick={close}>
          <Icon name="back" size={22} />
        </button>
        <div className="topbar-title"><span className="t">Configurações</span></div>
      </header>
      <div className="settings-body">
        <section className={`cfg-card cfg-switch-card${skip ? ' on' : ''}`}>
          <label className="cfg-switch-row">
            <span className="cfg-switch-text">
              <strong>🔓 Permitir tudo</strong>
              <span className="cfg-desc">Executa todas as ferramentas no PC sem pedir confirmação, em todas as conversas. Aplica na hora — use com cuidado.</span>
            </span>
            <input className="cfg-switch-input" type="checkbox" checked={skip} onChange={(e) => client.setSkipPerms(e.currentTarget.checked)} />
            <span className="cfg-switch-visual" aria-hidden="true" />
          </label>
        </section>
        <UsageCard />
        <VoiceCard />
        <section className="cfg-card">
          <div className="cfg-card-title">Conexão</div>
          <div className="cfg-row"><span className="cfg-k">Endereço</span><span className="cfg-v">{base ? base.replace(/^https?:\/\//, '') : '—'}</span></div>
          <div className="cfg-row"><span className="cfg-k">Token</span><span className="cfg-v">{token || '—'}</span></div>
          <button type="button" className="cfg-exit" onClick={confirmExit}>Sair desta conexão</button>
        </section>
      </div>
    </aside>
  )
}
