import { useEffect, useState } from 'react'
import type {
  PostgresConnectionDraft,
  PostgresPublicSettings,
  StorageStatusDto
} from '@shared/ipc'
import type { CloudInspectionDto, CloudSwitchAction, DatabaseSide } from '@shared/databaseBackup'
import { useUI } from './UiProvider'
import { ipcErrorMessage } from '../ipcError'
import { IconDatabase, IconEye, IconEyeOff } from '../components/Icons'
import { CloudSwitchDialog } from './CloudSwitchDialog'

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

const TRANSITIONS: ReadonlyArray<StorageStatusDto['state']> = [
  'activating-postgres',
  'deactivating-postgres',
  'switching-postgres',
  'restoring-postgres'
]

function stateLabel(status: StorageStatusDto | null, cloudOn: boolean): string {
  switch (status?.state) {
    case undefined:
    case 'booting':
      return 'abrindo…'
    case 'postgres-ready':
      return cloudOn ? 'na nuvem' : 'local'
    case 'postgres-offline':
      return cloudOn ? 'nuvem fora do ar' : 'banco fora do ar'
    case 'sqlite-ready':
      return 'SQLite (recuperação)'
    case 'testing-postgres':
      return 'testando…'
    case 'switching-postgres':
      return 'trocando…'
    case 'restoring-postgres':
      return 'restaurando…'
    case 'fatal':
      return 'erro'
    default:
      return 'em transição…'
  }
}

/**
 * Configurações → Dados: o banco das conversas. O padrão é o PostgreSQL deste PC;
 * a chave liga um PostgreSQL na nuvem (os campos aparecem com ela), e ligar ou
 * desligar abre o diálogo de qual lado manter (CloudSwitchDialog), com backup
 * antes de sobrescrever. A volta ao SQLite saiu da tela (o backend continua).
 */
export function PostgresSettingsSection(): JSX.Element {
  const { notify } = useUI()
  const [status, setStatus] = useState<StorageStatusDto | null>(null)
  const [settings, setSettings] = useState<PostgresPublicSettings | null>(null)
  const [draft, setDraft] = useState(DEFAULT_DRAFT)
  const [wantCloud, setWantCloud] = useState(false)
  const [inspection, setInspection] = useState<CloudInspectionDto | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [busy, setBusy] = useState<'test' | 'inspect' | 'switch' | 'retry' | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.api.getStorageStatus(), window.api.getPostgresSettings()]).then(([nextStatus, saved]) => {
      if (cancelled) return
      setStatus(nextStatus)
      setSettings(saved)
      setDraft(draftFromSettings(saved))
      setWantCloud(nextStatus.backend === 'postgres' && saved.postgresTarget === 'cloud')
    })
    const offStatus = window.api.onStorageStatusChanged((next) => {
      if (!cancelled) setStatus(next)
    })
    const offResult = window.api.onStorageTransitionResult?.((result) => {
      if (!cancelled) notify(result.ok ? 'sucesso' : 'erro', result.message)
    })
    return () => {
      cancelled = true
      offStatus()
      offResult?.()
    }
  }, [notify])

  const cloudOn = status?.backend === 'postgres' && settings?.postgresTarget === 'cloud'
  const onSqlite = status?.backend === 'sqlite'
  const transitioning = status ? TRANSITIONS.includes(status.state) : false

  const run = async (kind: NonNullable<typeof busy>, action: () => Promise<void>): Promise<boolean> => {
    setBusy(kind)
    try {
      await action()
      return true
    } catch (error) {
      notify('erro', errorMessage(error))
      return false
    } finally {
      setBusy(null)
    }
  }

  const inspect = async (action: CloudSwitchAction): Promise<void> => {
    const ok = await run('inspect', async () => {
      setInspection(await window.api.inspectCloudDatabase(action, action === 'ligar' ? draft : undefined))
    })
    if (!ok && action === 'desligar') setWantCloud(true)
  }

  const toggle = (on: boolean): void => {
    setWantCloud(on)
    setInspection(null)
    if (!on && cloudOn) void inspect('desligar')
  }

  const test = (): void => {
    void run('test', async () => {
      await window.api.testPostgresConnection(draft)
      notify('sucesso', 'Conexão com a nuvem validada. Nada foi trocado.')
    })
  }

  const continueOn = (): void => {
    if (!onSqlite) {
      void inspect('ligar')
      return
    }
    // SQLite de recuperação (a importação para o local não terminou): o caminho antigo, SQLite → nuvem.
    void run('switch', async () => {
      if (await window.api.activatePostgres(draft)) notify('sucesso', 'Nuvem ligada. O aplicativo será reiniciado.')
    })
  }

  const confirm = (keep: DatabaseSide): void => {
    if (!inspection) return
    const action = inspection.action
    void run('switch', async () => {
      const { message } = await window.api.switchCloudDatabase({ action, keep, ...(action === 'ligar' ? { draft } : {}) })
      notify('sucesso', message)
    })
  }

  const cancelDialog = (): void => {
    setInspection(null)
    setWantCloud(cloudOn)
  }

  const retry = (): void => {
    void run('retry', async () => {
      await window.api.retryStorage(draft)
      notify('sucesso', 'Conexão com a nuvem restabelecida.')
      window.dispatchEvent(new Event('agent-code-request-reload'))
    })
  }

  const clearPassword = async (): Promise<void> => {
    await window.api.clearPostgresPassword()
    setDraft((current) => ({ ...current, password: '' }))
    setStatus((current) => (current ? { ...current, hasPassword: false } : current))
    setConfirmClear(false)
    notify('aviso', 'Senha da nuvem removida desta instalação.')
  }

  const disabled = !status || busy !== null || transitioning
  const field = (key: keyof PostgresConnectionDraft) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [key]: key === 'port' ? Number(event.target.value) : event.target.value }))

  return (
    <section className={`settings-section settings-switch-section postgres-settings ${wantCloud ? 'on' : ''}`}>
      <label className="settings-switch-row">
        <span className="settings-switch-text">
          <strong className="settings-inline-title">
            <IconDatabase size={15} /> Usar PostgreSQL na nuvem
          </strong>
          <span className="settings-desc">
            Por padrão as conversas ficam no PostgreSQL deste PC, sem esperar a rede. Ligada, o app usa um PostgreSQL seu
            na nuvem — o mesmo de outro PC, por exemplo. Ao ligar ou desligar, você escolhe qual lado manter, e o lado
            substituído vira backup antes.
          </span>
        </span>
        <span className={`storage-status storage-${status?.state ?? 'booting'}`}>{stateLabel(status, cloudOn)}</span>
        <input
          className="switch-input"
          type="checkbox"
          aria-label="Usar PostgreSQL na nuvem"
          checked={wantCloud}
          disabled={disabled || inspection !== null}
          onChange={(event) => toggle(event.target.checked)}
        />
        <span className="switch-visual" aria-hidden="true" />
      </label>

      {status?.error && <div className="settings-warn">{status.error.message}</div>}
      {transitioning && status?.transitionStep && !inspection && (
        <div className="settings-hint" role="status">{status.transitionStep}…</div>
      )}

      {wantCloud && !inspection && (
        <>
          <div className="settings-key-row">
            <label className="settings-field settings-field-inline">
              <span className="settings-field-label">Host</span>
              <input className="settings-input" value={draft.host} disabled={disabled} onChange={field('host')} />
            </label>
            <label className="settings-field settings-field-inline">
              <span className="settings-field-label">Porta</span>
              <input className="settings-input" type="number" min={1} max={65535} value={draft.port} disabled={disabled} onChange={field('port')} />
            </label>
          </div>
          <label className="settings-field">
            <span className="settings-field-label">Usuário</span>
            <input className="settings-input" value={draft.user} disabled={disabled} autoComplete="username" onChange={field('user')} />
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
                onChange={field('password')}
              />
              <button
                className="btn ghost"
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                title={showPassword ? 'Esconder a senha' : 'Mostrar a senha'}
                aria-label={showPassword ? 'Esconder a senha' : 'Mostrar a senha'}
              >
                {showPassword ? <IconEyeOff size={15} /> : <IconEye size={15} />}
              </button>
            </div>
            <span className="settings-hint">A senha salva nunca volta para esta tela. Campo vazio mantém a criptografada.</span>
          </label>
          <div className="settings-key-row">
            <label className="settings-field settings-field-inline">
              <span className="settings-field-label">Maintenance database</span>
              <input className="settings-input" value={draft.maintenanceDatabase} disabled={disabled} onChange={field('maintenanceDatabase')} />
            </label>
            <label className="settings-field settings-field-inline">
              <span className="settings-field-label">Banco alvo</span>
              <input className="settings-input" value="agent-code" readOnly />
            </label>
          </div>
          <label className="settings-field">
            <span className="settings-field-label">TLS</span>
            <select className="settings-input" value={draft.tlsMode} disabled={disabled} onChange={field('tlsMode')}>
              <option value="disable">Desativado</option>
              <option value="prefer">Preferir TLS</option>
              <option value="require">Exigir TLS</option>
              <option value="verify-full">Verificar certificado e host</option>
            </select>
          </label>
          {draft.tlsMode === 'verify-full' && (
            <label className="settings-field">
              <span className="settings-field-label">CA PEM</span>
              <textarea className="settings-input" rows={4} value={draft.ca} disabled={disabled} onChange={field('ca')} />
            </label>
          )}
          <div className="modal-actions postgres-actions">
            <button className="btn ghost" type="button" disabled={disabled} onClick={test}>
              {busy === 'test' ? 'Testando…' : 'Testar conexão'}
            </button>
            {!cloudOn && (
              <button className="btn primary" type="button" disabled={disabled} onClick={continueOn}>
                {busy === 'inspect' ? 'Conferindo os dois lados…' : 'Testar e continuar…'}
              </button>
            )}
            {status?.state === 'postgres-offline' && (
              <button className="btn primary" type="button" disabled={busy !== null} onClick={retry}>
                {busy === 'retry' ? 'Tentando…' : 'Tentar novamente'}
              </button>
            )}
          </div>
        </>
      )}

      {busy === 'inspect' && !wantCloud && <div className="settings-hint" role="status">Conferindo o que cada lado tem…</div>}

      {inspection && (
        <CloudSwitchDialog
          inspection={inspection}
          busy={busy === 'switch' || transitioning}
          step={status?.transitionStep}
          onConfirm={confirm}
          onCancel={cancelDialog}
        />
      )}

      {wantCloud && status?.hasPassword && !confirmClear && !inspection && (
        <button className="btn ghost" type="button" disabled={disabled} onClick={() => setConfirmClear(true)}>
          Limpar senha salva…
        </button>
      )}
      {confirmClear && (
        <div className="settings-warn">
          Remover a senha impedirá a reconexão com a nuvem até uma nova senha ser informada.
          <div className="modal-actions">
            <button className="btn ghost" type="button" onClick={() => setConfirmClear(false)}>Cancelar</button>
            <button className="btn danger-btn" type="button" onClick={() => void clearPassword()}>Limpar senha</button>
          </div>
        </div>
      )}
    </section>
  )
}
