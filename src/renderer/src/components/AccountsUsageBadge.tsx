import { useEffect, useRef, useState } from 'react'
import type { RateLimitStatus } from '@shared/ipc'
import type { AccountUsageReading, ClaudeAccountView } from '@shared/claudeAccounts'
import { accountDisplayName, readingToLimits, updatedAgo } from '../accounts/accountUsageView'
import { IconChevronDown } from './Icons'
import { UsagePill } from './UsageBadge'

/** Estado de uma seção enquanto o painel está aberto. */
interface Live {
  reading: AccountUsageReading | null
  loading: boolean
  fresh: boolean
}

interface Props {
  accounts: ClaudeAccountView[]
  /** Conta da conversa aberta (a barra fechada mostra ela). */
  activeAccountId: string | null
  /** Há conversa aberta num modelo Claude? Sem isso não há "usar nesta conversa". */
  canUseInConversation: boolean
  gptLimits: RateLimitStatus[]
  /** "mostrar na barra" por conta (id) e para o GPT ('gpt'). Ausente = marcado. */
  shownInBar: Record<string, boolean>
  onShownInBarChange: (next: Record<string, boolean>) => void
  onUseAccount: (accountId: string) => void
  onRelogin: (accountId: string) => void
  onManage: () => void
}

/**
 * Painel de consumo com várias contas Claude. Fechado: a conta da conversa
 * aberta (com o apelido) e o GPT. Aberto: uma seção por conta, na ordem do
 * usuário, com a última leitura na hora ("atualizando…") e a consulta de
 * verdade de todas as contas em paralelo — o main tem cache de 60 s, então
 * abrir e fechar várias vezes não abre vários processos.
 */
export function AccountsUsageBadge(props: Props): JSX.Element {
  const { accounts, activeAccountId, shownInBar } = props
  const [open, setOpen] = useState(false)
  const [live, setLive] = useState<Record<string, Live>>({})
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

  // Ao abrir: última leitura na hora, e a consulta de cada conta atualiza a
  // seção dela quando chega. Falha mantém o valor antigo (fresh: false).
  useEffect(() => {
    if (!open) return
    let alive = true
    setLive(Object.fromEntries(accounts.map((a) => [a.id, { reading: a.usage, loading: true, fresh: true }])))
    for (const account of accounts) {
      if (account.status !== 'connected') {
        setLive((prev) => ({ ...prev, [account.id]: { reading: account.usage, loading: false, fresh: false } }))
        continue
      }
      void window.api
        .claudeAccountsUsage(false, account.id)
        .then(([result]) => {
          if (!alive) return
          setLive((prev) => ({
            ...prev,
            [account.id]: { reading: result?.reading ?? account.usage, loading: false, fresh: result?.fresh ?? false }
          }))
        })
        .catch(() => {
          if (alive) setLive((prev) => ({ ...prev, [account.id]: { reading: account.usage, loading: false, fresh: false } }))
        })
    }
    return () => {
      alive = false
    }
    // Só ao abrir: a lista muda com eventos, e isso não pode disparar outra consulta.
  }, [open])

  const shown = (key: string): boolean => shownInBar[key] !== false
  const toggle = (key: string): void => props.onShownInBarChange({ ...shownInBar, [key]: !shown(key) })
  const activeIndex = accounts.findIndex((a) => a.id === activeAccountId)
  const active = activeIndex >= 0 ? accounts[activeIndex] : undefined
  const activeLimits = active && shown(active.id) ? readingToLimits(active.usage) : []
  const gptOnBar = shown('gpt') ? props.gptLimits : []
  const dense = activeLimits.length + gptOnBar.length > 2

  return (
    <div className={`usage-badge${open ? ' open' : ''}`} ref={rootRef}>
      {active && activeLimits.length > 0 && (
        <div className="usage-group">
          <span className="usage-provider" title={active.email ?? ''}>
            Claude · {accountDisplayName(active, activeIndex)}
          </span>
          {activeLimits.map((l) => (
            <UsagePill key={l.rateLimitType} limit={l} dense={dense} />
          ))}
        </div>
      )}
      {gptOnBar.length > 0 && (
        <div className="usage-group">
          <span className="usage-provider">GPT</span>
          {gptOnBar.map((l) => (
            <UsagePill key={l.rateLimitType} limit={l} dense={dense} />
          ))}
        </div>
      )}
      {activeLimits.length === 0 && gptOnBar.length === 0 && <span className="usage-provider muted">Uso</span>}
      <button
        type="button"
        className="usage-expand"
        onClick={() => setOpen((v) => !v)}
        title="Ver o consumo de todas as contas"
        aria-expanded={open}
        aria-label="Detalhar consumo"
      >
        <IconChevronDown size={13} />
      </button>
      {open && (
        <div className="usage-popover" role="dialog" aria-label="Consumo das contas">
          {accounts.map((account, index) => {
            const state = live[account.id]
            const limits = readingToLimits(state?.reading ?? account.usage)
            const isActive = account.id === activeAccountId
            return (
              <section className={`usage-popover-section${isActive ? ' usage-account-active' : ''}`} key={account.id}>
                <label className="usage-popover-head">
                  <input type="checkbox" checked={shown(account.id)} onChange={() => toggle(account.id)} />
                  <strong title={account.email ?? ''}>Claude · {accountDisplayName(account, index)}</strong>
                  {isActive && <span className="usage-account-tag">nesta conversa</span>}
                  <span className="usage-popover-hint">mostrar na barra</span>
                </label>
                {limits.length > 0 ? (
                  <div className="usage-popover-items">
                    {limits.map((l) => (
                      <UsagePill key={l.rateLimitType} limit={l} />
                    ))}
                  </div>
                ) : (
                  <span className="usage-popover-empty">Sem leitura ainda.</span>
                )}
                <div className="usage-account-foot">
                  <span className="usage-popover-hint">
                    {state?.loading
                      ? 'atualizando…'
                      : state && !state.fresh && state.reading
                        ? updatedAgo(state.reading.at)
                        : ''}
                  </span>
                  {account.status !== 'connected' ? (
                    <button type="button" className="btn ghost" onClick={() => props.onRelogin(account.id)}>
                      Entrar de novo
                    </button>
                  ) : (
                    !isActive &&
                    props.canUseInConversation && (
                      <button type="button" className="btn ghost" onClick={() => props.onUseAccount(account.id)}>
                        Usar nesta conversa
                      </button>
                    )
                  )}
                </div>
              </section>
            )
          })}
          <section className="usage-popover-section">
            <label className="usage-popover-head">
              <input type="checkbox" checked={shown('gpt')} onChange={() => toggle('gpt')} />
              <strong>GPT</strong>
              <span className="usage-popover-hint">mostrar na barra</span>
            </label>
            {props.gptLimits.length > 0 ? (
              <div className="usage-popover-items">
                {props.gptLimits.map((l) => (
                  <UsagePill key={l.rateLimitType} limit={l} />
                ))}
              </div>
            ) : (
              <span className="usage-popover-empty">Sem dados ainda — use um modelo GPT com a conta ChatGPT conectada.</span>
            )}
          </section>
          <button type="button" className="btn ghost usage-manage" onClick={props.onManage}>
            Gerenciar contas
          </button>
        </div>
      )}
    </div>
  )
}
