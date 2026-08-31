import { useEffect, useMemo, useState } from 'react'
import type {
  PostgresConnectionDraft,
  PostgresPublicSettings,
  StorageStatusDto
} from '@shared/ipc'
import { useUI } from './UiProvider'
import { ipcErrorMessage } from '../ipcError'

const DEFAULT_DRAFT: PostgresConnectionDraft = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '',
  maintenanceDatabase: 'postgres',
  tlsMode: 'disable',
  ca: ''
}

function draftFromSettings(settings: PostgresPublicSettings): PostgresConnectionDraft {
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: '',
    maintenanceDatabase: settings.maintenanceDatabase,
    tlsMode: settings.tlsMode,
    ca: settings.ca
  }
}

function errorMessage(error: unknown): string {
  return ipcErrorMessage(error, 'A operação PostgreSQL falhou.')
}

function requestSafeReload(): void {
  window.dispatchEvent(new Event('agent-code-request-reload'))
}

export function PostgresSettingsSection(): JSX.Element {
  const { notify } = useUI()
  const [status, setStatus] = useState<StorageStatusDto | null>(null)
  const [draft, setDraft] = useState(DEFAULT_DRAFT)
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState<'test' | 'activate' | 'deactivate' | 'retry' | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.api.getStorageStatus(), window.api.getPostgresSettings()]).then(
      ([nextStatus, settings]) => {
        if (cancelled) return
        setStatus(nextStatus)
        setDraft(draftFromSettings(settings))
      }
    )
    const off = window.api.onStorageStatusChanged((next) => {
      if (!cancelled) setStatus(next)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const transitioning = useMemo(
    () => status?.state === 'activating-postgres' || status?.state === 'deactivating-postgres',
    [status?.state]
  )

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    try {
      await action()
    } catch (error) {
      notify('erro', errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const test = (): void => {
    void run('test', async () => {
      await window.api.testPostgresConnection(draft)
      notify('sucesso', 'Conexão PostgreSQL validada. Nenhum backend foi alterado.')
    })
  }

  const activate = (): void => {
    void run('activate', async () => {
      const activated = await window.api.activatePostgres(draft)
      if (!activated) return
      notify('sucesso', 'PostgreSQL ativado. O aplicativo será reiniciado.')
    })
  }

  const deactivate = (): void => {
    void run('deactivate', async () => {
      const deactivated = await window.api.deactivatePostgres()
      if (!deactivated) return
      notify('sucesso', 'SQLite ativado. O aplicativo será reiniciado.')
    })
  }

  const retry = (): void => {
    void run('retry', async () => {
      await window.api.retryStorage(draft)
      notify('sucesso', 'Conexão PostgreSQL restabelecida.')
      requestSafeReload()
    })
  }

  const clearPassword = async (): Promise<void> => {
    await window.api.clearPostgresPassword()
    setDraft((current) => ({ ...current, password: '' }))
    setStatus((current) => (current ? { ...current, hasPassword: false } : current))
    setConfirmClear(false)
    notify('aviso', 'Senha PostgreSQL removida desta instalação.')
  }

  const disabled = !status || busy !== null || transitioning
  const postgresActive = status?.backend === 'postgres'

  return (
    <section className={`settings-section postgres-settings ${postgresActive ? 'on' : ''}`}>
      <div className="settings-row">
        <span>
          <strong>🐘 PostgreSQL</strong>
          <span className="settings-desc">
            Backend opcional para compartilhar histórico e sessões entre computadores. A troca só ocorre pelo
            botão de migração depois da verificação; salvar as demais configurações não ativa o banco.
          </span>
        </span>
        <span className={`storage-status storage-${status?.state ?? 'booting'}`}>
          {status?.state ?? 'carregando'}
        </span>
      </div>

      {status?.error && <div className="settings-warn">{status.error.message}</div>}
      {transitioning && status?.transitionStep && (
        <div className="settings-hint" role="status">{status.transitionStep}…</div>
      )}

      <div className="settings-key-row">
        <label className="settings-field settings-field-inline">
          <span className="settings-field-label">Host</span>
          <input
            className="settings-input"
            value={draft.host}
            disabled={disabled}
            onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))}
          />
        </label>
        <label className="settings-field settings-field-inline">
          <span className="settings-field-label">Porta</span>
          <input
            className="settings-input"
            type="number"
            min={1}
            max={65535}
            value={draft.port}
            disabled={disabled}
            onChange={(event) => setDraft((current) => ({ ...current, port: Number(event.target.value) }))}
          />
        </label>
      </div>

      <label className="settings-field">
        <span className="settings-field-label">Usuário</span>
        <input
          className="settings-input"
          value={draft.user}
          disabled={disabled}
          autoComplete="username"
          onChange={(event) => setDraft((current) => ({ ...current, user: event.target.value }))}
        />
      </label>

      <label className="settings-field">
        <span className="settings-field-label">Senha</span>
        <div className="settings-key-row">
          <input
            className="settings-input"
            type={showPassword ? 'text' : 'password'}
            value={draft.password}
            placeholder={status?.hasPassword ? 'Senha salva — deixe vazio para manter' : 'Informe a senha'}
            disabled={disabled}
            autoComplete="new-password"
            onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))}
          />
          <button className="btn ghost" type="button" onClick={() => setShowPassword((value) => !value)}>
            {showPassword ? '🙈' : '👁️'}
          </button>
        </div>
        <span className="settings-hint">
          A senha salva nunca volta para esta tela. Campo vazio mantém o segredo criptografado existente.
        </span>
      </label>

      <div className="settings-key-row">
        <label className="settings-field settings-field-inline">
          <span className="settings-field-label">Maintenance database</span>
          <input
            className="settings-input"
            value={draft.maintenanceDatabase}
            disabled={disabled}
            onChange={(event) =>
              setDraft((current) => ({ ...current, maintenanceDatabase: event.target.value }))
            }
          />
        </label>
        <label className="settings-field settings-field-inline">
          <span className="settings-field-label">Banco alvo</span>
          <input className="settings-input" value="agent-code" readOnly />
        </label>
      </div>

      <label className="settings-field">
        <span className="settings-field-label">TLS</span>
        <select
          className="settings-input"
          value={draft.tlsMode}
          disabled={disabled}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              tlsMode: event.target.value as PostgresConnectionDraft['tlsMode']
            }))
          }
        >
          <option value="disable">Desativado</option>
          <option value="prefer">Preferir TLS</option>
          <option value="require">Exigir TLS</option>
          <option value="verify-full">Verificar certificado e host</option>
        </select>
      </label>

      {draft.tlsMode === 'verify-full' && (
        <label className="settings-field">
          <span className="settings-field-label">CA PEM</span>
          <textarea
            className="settings-input"
            rows={4}
            value={draft.ca}
            disabled={disabled}
            onChange={(event) => setDraft((current) => ({ ...current, ca: event.target.value }))}
          />
        </label>
      )}

      <div className="modal-actions postgres-actions">
        <button className="btn ghost" type="button" disabled={disabled} onClick={test}>
          {busy === 'test' ? 'Testando…' : 'Testar conexão'}
        </button>
        {!postgresActive ? (
          <button className="btn primary" type="button" disabled={disabled} onClick={activate}>
            {busy === 'activate' ? 'Ativando…' : 'Ativar e migrar'}
          </button>
        ) : (
          <button className="btn ghost" type="button" disabled={disabled || status?.state === 'postgres-offline'} onClick={deactivate}>
            {busy === 'deactivate' ? 'Desativando…' : 'Desativar e migrar para SQLite'}
          </button>
        )}
        {status?.state === 'postgres-offline' && (
          <button className="btn primary" type="button" disabled={busy !== null} onClick={retry}>
            {busy === 'retry' ? 'Tentando…' : 'Tentar novamente'}
          </button>
        )}
      </div>

      {status?.hasPassword && !confirmClear && (
        <button className="btn ghost" type="button" disabled={disabled} onClick={() => setConfirmClear(true)}>
          Limpar senha salva…
        </button>
      )}
      {confirmClear && (
        <div className="settings-warn">
          Remover a senha impedirá a reconexão até uma nova senha ser informada.
          <div className="modal-actions">
            <button className="btn ghost" type="button" onClick={() => setConfirmClear(false)}>Cancelar</button>
            <button className="btn danger-btn" type="button" onClick={() => void clearPassword()}>Limpar senha</button>
          </div>
        </div>
      )}
    </section>
  )
}
