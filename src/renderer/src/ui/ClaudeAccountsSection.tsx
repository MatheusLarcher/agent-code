import { useCallback, useEffect, useState, type DragEvent } from 'react'
import type { ClaudeAccountStatus, ClaudeAccountView } from '@shared/claudeAccounts'
import { useUI } from './UiProvider'

const STATUS_LABEL: Record<ClaudeAccountStatus, string> = {
  connected: 'conectada',
  expired: 'login expirado',
  'logged-out': 'sem login'
}

/** Nome visível: o apelido; sem apelido, o e-mail; sem e-mail, "Conta N". */
function accountName(account: ClaudeAccountView, index: number): string {
  return account.label || account.email || `Conta ${index + 1}`
}

/** Maior janela da última leitura ainda não vencida — só para referência na lista. */
function lastUsage(account: ClaudeAccountView): string | null {
  const reading = account.usage
  if (!reading) return null
  const now = Date.now()
  let max: number | null = null
  for (const window of Object.values(reading.windows)) {
    if (window.resetsAt != null && window.resetsAt <= now) continue
    if (window.utilization != null) max = Math.max(max ?? 0, window.utilization)
  }
  return max == null ? null : `${Math.round(max)}% usado`
}

/**
 * Configurações → Modelos → Contas Claude. Cada conta tem uma pasta de login
 * própria (o CLI oficial, sem proxy). A ordem daqui é a ordem em que conversas
 * novas escolhem a conta: a primeira abaixo de 95% leva. Nenhum token chega
 * aqui — só apelido, e-mail, plano e status.
 */
export function ClaudeAccountsSection({ highlight = false }: { highlight?: boolean }): JSX.Element {
  const { notify, confirm } = useUI()
  // Interruptor "Troca automática de conta" (padrão: ligado). Só aparece com
  // mais de uma conta — com uma só não há para onde trocar.
  const [autoSwitch, setAutoSwitch] = useState(true)
  useEffect(() => {
    void window.api.claudeAccountsAutoSwitch?.().then(setAutoSwitch).catch(() => undefined)
  }, [])
  const toggleAutoSwitch = async (on: boolean): Promise<void> => {
    setAutoSwitch(on)
    const saved = await window.api.claudeAccountsAutoSwitch(on).catch(() => !on)
    setAutoSwitch(saved)
    if (saved !== on) notify('erro', 'Não foi possível salvar o interruptor.')
    else notify('sucesso', on ? 'Troca automática de conta ligada.' : 'Troca automática de conta desligada.')
  }
  const [accounts, setAccounts] = useState<ClaudeAccountView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setAccounts((await window.api.claudeAccountsList?.().catch(() => null)) ?? [])
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const add = async (): Promise<void> => {
    setBusy('add')
    notify('aviso', 'Abrindo o navegador: entre com a conta Claude que quer adicionar.')
    try {
      const result = await window.api.claudeAccountsAdd()
      if (result.ok) {
        notify('sucesso', result.account.email ? `Conta ${result.account.email} adicionada.` : 'Conta adicionada.')
        await refresh()
      } else if (result.reason === 'duplicate') {
        notify('aviso', `A conta ${result.email} já está na lista.`)
      } else if (result.reason === 'busy') {
        notify('aviso', 'Já existe um login em andamento. Termine-o no navegador e tente de novo.')
      } else {
        notify('erro', 'O login não foi concluído. Nenhuma conta foi adicionada.')
      }
    } finally {
      setBusy(null)
    }
  }

  const relogin = async (account: ClaudeAccountView): Promise<void> => {
    setBusy(account.id)
    try {
      const { ok } = await window.api.claudeAccountsRelogin(account.id)
      notify(ok ? 'sucesso' : 'erro', ok ? 'Login renovado.' : 'O login não foi concluído.')
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const saveLabel = async (): Promise<void> => {
    if (!editing) return
    const { id, label } = editing
    setEditing(null)
    const { ok } = await window.api.claudeAccountsRename(id, label)
    if (!ok) notify('erro', 'Não foi possível renomear a conta.')
    await refresh()
  }

  const remove = async (account: ClaudeAccountView, index: number): Promise<void> => {
    const confirmed = await confirm({
      title: 'Remover conta Claude',
      message: `Remover "${accountName(account, index)}"? A pasta de login dela é apagada. As conversas que usavam esta conta passam a usar a próxima conta disponível.`,
      confirmLabel: 'Remover',
      danger: true
    })
    if (!confirmed) return
    const { ok } = await window.api.claudeAccountsRemove(account.id)
    notify(ok ? 'sucesso' : 'erro', ok ? 'Conta removida.' : 'Não foi possível remover a conta.')
    await refresh()
  }

  // Arrastar para reordenar: a nova ordem vale na próxima conversa nova.
  const onDrop = async (event: DragEvent, targetId: string): Promise<void> => {
    event.preventDefault()
    const sourceId = dragId
    setDragId(null)
    if (!sourceId || sourceId === targetId) return
    const ids = accounts.map((account) => account.id)
    const from = ids.indexOf(sourceId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0) return
    ids.splice(to, 0, ...ids.splice(from, 1))
    setAccounts((current) => ids.map((id) => current.find((account) => account.id === id)!).filter(Boolean))
    const { ok } = await window.api.claudeAccountsReorder(ids)
    if (!ok) notify('erro', 'Não foi possível salvar a nova ordem.')
    await refresh()
  }

  return (
    <section className={`settings-section claude-accounts ${highlight ? 'settings-highlight' : ''}`}>
      <div className="settings-row">
        <span>
          <strong>Contas Claude</strong>
          <span className="settings-desc">
            Cada conversa roda numa conta. Conversa nova usa a primeira conta desta lista que está abaixo de
            95% de uso; arraste para mudar a ordem. Cada conta tem o próprio login, feito pelo navegador.
          </span>
        </span>
        <button className="btn ghost" type="button" onClick={() => void add()} disabled={busy !== null}>
          {busy === 'add' ? 'Aguardando login…' : 'Adicionar conta'}
        </button>
      </div>

      {accounts.length > 1 && (
        <label className="settings-switch-row">
          <span className="settings-switch-text">
            <strong>Troca automática de conta</strong>
            <span className="settings-desc">
              No fim de uma resposta, se a conta da conversa passou de 95% de uso, a conversa segue na conta de menor
              consumo (se alguma estiver abaixo de 95%). Se a conta estourar no meio da tarefa, a tarefa continua na
              próxima conta; o GPT só entra quando todas as contas Claude estouraram. Desligado, nada troca sozinho.
            </span>
          </span>
          <input
            className="switch-input"
            type="checkbox"
            checked={autoSwitch}
            onChange={(event) => void toggleAutoSwitch(event.target.checked)}
          />
          <span className="switch-visual" aria-hidden="true" />
        </label>
      )}

      <div className="settings-list">
        {!loaded && <span className="settings-hint">Carregando…</span>}
        {accounts.map((account, index) => (
          <div
            className={`settings-list-row claude-account-row ${dragId === account.id ? 'dragging' : ''}`}
            key={account.id}
            draggable={editing?.id !== account.id}
            onDragStart={() => setDragId(account.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => void onDrop(event, account.id)}
          >
            <span className="claude-account-handle" aria-hidden="true" title="Arraste para reordenar">
              ⋮⋮
            </span>
            <span className="settings-list-main" title={account.email ?? ''}>
              {editing?.id === account.id ? (
                <input
                  className="settings-input"
                  autoFocus
                  maxLength={80}
                  value={editing.label}
                  placeholder={account.email ?? 'Apelido'}
                  onChange={(event) => setEditing({ id: account.id, label: event.target.value })}
                  onBlur={() => void saveLabel()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveLabel()
                    if (event.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <>
                  <strong>{index + 1}. {accountName(account, index)}</strong>
                  {account.label && account.email ? <span className="settings-list-reason"> — {account.email}</span> : null}
                  {account.isDefault ? <span className="settings-list-reason"> (login desta máquina)</span> : null}
                </>
              )}
            </span>
            <span className="settings-list-meta">
              {[account.plan, STATUS_LABEL[account.status], lastUsage(account)].filter(Boolean).join(' · ')}
            </span>
            {account.status !== 'connected' && !account.isDefault && (
              <button className="btn ghost" type="button" disabled={busy !== null} onClick={() => void relogin(account)}>
                {busy === account.id ? 'Aguardando…' : 'Entrar de novo'}
              </button>
            )}
            <button
              className="btn ghost"
              type="button"
              onClick={() => setEditing({ id: account.id, label: account.label })}
            >
              Renomear
            </button>
            {!account.isDefault && (
              <button className="btn ghost" type="button" onClick={() => void remove(account, index)}>
                Remover
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
