import { useCallback, useEffect, useRef, useState } from 'react'
import type { StorageStatusDto } from '@shared/ipc'
import type { BackupReason, DatabaseBackupDto, DatabaseBackupListDto, DatabaseSide } from '@shared/databaseBackup'
import { useUI } from './UiProvider'
import { ipcErrorMessage } from '../ipcError'
import { IconDatabase } from '../components/Icons'
import { ReadRetry } from '../components/ReadRetry'

const REASON_LABEL: Record<BackupReason, string> = {
  diario: 'diário',
  'antes-da-troca': 'antes da troca',
  'antes-da-restauracao': 'antes da restauração'
}

const SIDE_LABEL: Record<DatabaseSide, string> = { local: 'local', nuvem: 'nuvem' }

function when(iso: string): string {
  const date = new Date(iso)
  return Number.isFinite(date.valueOf()) ? date.toLocaleString('pt-BR') : iso
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * Configurações → Dados: os backups do banco (pg_dump) na pasta de dados — o
 * diário e os de antes de uma troca ou restauração, no máximo 10 de cada. Restaurar
 * só quando o usuário escolhe, e o estado atual do destino vira backup antes.
 */
export function BackupsSection(): JSX.Element {
  const { notify, confirm } = useUI()
  const [data, setData] = useState<DatabaseBackupListDto | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [status, setStatus] = useState<StorageStatusDto | null>(null)
  const [chosen, setChosen] = useState<DatabaseBackupDto | null>(null)
  const [target, setTarget] = useState<DatabaseSide>('local')
  const [busy, setBusy] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  // A confirmação abre abaixo da lista: traz para a vista.
  useEffect(() => {
    if (chosen) panelRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [chosen])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setData(await window.api.listDatabaseBackups())
      setLoadError(null)
    } catch (error) {
      setLoadError(error)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void window.api.getStorageStatus().then(setStatus).catch(() => undefined)
    const offList = window.api.onDatabaseBackupsChanged(() => void refresh())
    const offStatus = window.api.onStorageStatusChanged(setStatus)
    return () => {
      offList()
      offStatus()
    }
  }, [refresh])

  const restoring = status?.state === 'restoring-postgres'
  const switching = status?.state === 'switching-postgres'

  const openRestore = (item: DatabaseBackupDto): void => {
    setChosen(item)
    setTarget(data?.activeSide ?? 'local')
  }

  const restore = async (): Promise<void> => {
    if (!chosen) return
    setBusy(true)
    try {
      const outcome = await window.api.restoreDatabaseBackup({ file: chosen.file, target })
      notify('sucesso', outcome.message)
      setChosen(null)
      void refresh()
    } catch (error) {
      notify('erro', ipcErrorMessage(error, 'A restauração falhou; o destino ficou como estava.'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (item: DatabaseBackupDto): Promise<void> => {
    const ok = await confirm({
      title: 'Apagar backup',
      message: `Apagar o backup de ${when(item.createdAt)} (${SIDE_LABEL[item.side]}, ${REASON_LABEL[item.reason]})? Não dá para desfazer.`,
      confirmLabel: 'Apagar',
      danger: true
    })
    if (!ok) return
    try {
      await window.api.deleteDatabaseBackup(item.file)
      if (chosen?.file === item.file) setChosen(null)
      void refresh()
    } catch (error) {
      notify('erro', ipcErrorMessage(error, 'Não foi possível apagar o backup.'))
    }
  }

  const disabled = busy || restoring || switching || !data?.activeSide
  const targets: DatabaseSide[] = data?.cloudEnabled ? ['local', 'nuvem'] : ['local']

  return (
    <section className="settings-section backups-section">
      <span className="settings-field-label">
        <IconDatabase size={15} /> Backups do banco
      </span>
      <span className="settings-hint">
        Uma cópia do banco inteiro por dia, e outra antes de qualquer troca de banco ou restauração — no máximo
        10 de cada tipo. Ficam na pasta de dados, sem criptografia, como as memórias. Restaurar só acontece quando
        você escolhe, e antes o estado atual do destino também vira backup.
      </span>
      {data && (
        <span className="settings-hint backups-folder" title={data.dir}>
          {data.dir} · {data.items.length} backup(s), {formatBytes(data.totalBytes)} na pasta
        </span>
      )}
      {data?.running && (
        <span className="settings-hint" role="status">
          Fazendo o backup {REASON_LABEL[data.running.reason]} do banco {SIDE_LABEL[data.running.side]}…
        </span>
      )}
      {(restoring || switching) && status?.transitionStep && (
        <span className="settings-hint" role="status">
          {status.transitionStep}…
        </span>
      )}
      {loadError ? <ReadRetry error={loadError} what="a lista de backups" onRetry={() => void refresh()} /> : null}

      <div className="settings-list">
        {!data && !loadError && <span className="settings-hint">Carregando…</span>}
        {data && !data.items.length && <span className="settings-hint">Nenhum backup ainda.</span>}
        {data?.items.map((item) => (
          <div className={`settings-list-row ${chosen?.file === item.file ? 'chosen' : ''}`} key={item.file}>
            <span className="settings-list-main" title={item.file}>
              {when(item.createdAt)} · {SIDE_LABEL[item.side]} · {REASON_LABEL[item.reason]}
            </span>
            <span className="settings-list-meta">
              {item.conversations} conversa(s) · {formatBytes(item.sizeBytes)}
            </span>
            <button className="btn ghost" type="button" disabled={disabled} onClick={() => openRestore(item)}>
              Restaurar…
            </button>
            <button className="btn ghost" type="button" disabled={busy || restoring} onClick={() => void remove(item)}>
              Apagar
            </button>
          </div>
        ))}
      </div>

      {chosen && (
        <div className="settings-warn backups-restore" ref={panelRef}>
          <span>
            Restaurar o backup de <strong>{when(chosen.createdAt)}</strong> ({SIDE_LABEL[chosen.side]},{' '}
            {REASON_LABEL[chosen.reason]}, {chosen.conversations} conversa(s))?
          </span>
          {targets.length > 1 && (
            <div className="backups-targets" role="radiogroup" aria-label="Destino da restauração">
              {targets.map((side) => (
                <label key={side}>
                  <input
                    type="radio"
                    name="backup-target"
                    checked={target === side}
                    disabled={busy}
                    onChange={() => setTarget(side)}
                  />{' '}
                  {side === 'local' ? 'No banco local (este PC)' : 'Na nuvem'}
                </label>
              ))}
            </div>
          )}
          <span>
            O que está hoje no {target === 'local' ? 'banco local' : 'banco da nuvem'} é substituído — antes, ele vira um
            backup &quot;antes da restauração&quot;. Nenhuma conversa pode estar no meio de um turno.
            {target === data?.activeSide ? ' O app reinicia ao terminar.' : ''}
          </span>
          <div className="modal-actions">
            <button className="btn ghost" type="button" disabled={busy} onClick={() => setChosen(null)}>
              Cancelar
            </button>
            <button className="btn danger-btn" type="button" disabled={busy || restoring} onClick={() => void restore()}>
              {busy ? 'Restaurando…' : 'Restaurar'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
