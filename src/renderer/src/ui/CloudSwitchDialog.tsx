import { useState } from 'react'
import type { CloudInspectionDto, DatabaseSide, DatabaseSideSummaryDto } from '@shared/databaseBackup'

function when(iso: string | null): string {
  if (!iso) return 'nenhuma'
  const date = new Date(iso)
  return Number.isFinite(date.valueOf()) ? date.toLocaleString('pt-BR') : iso
}

function SideCard({ title, side }: { title: string; side: DatabaseSideSummaryDto }): JSX.Element {
  return (
    <div className="cloud-switch-side">
      <strong>{title}</strong>
      {!side.reachable ? (
        <span className="cloud-switch-warn">Sem conexão: {side.error ?? 'erro desconhecido'}</span>
      ) : !side.exists ? (
        <span>Vazio — o banco agent-code ainda não existe neste servidor.</span>
      ) : (
        <span>
          {side.conversations} conversa(s) · última atualização {when(side.lastUpdate)}
        </span>
      )}
      {side.serverVersion && <small className="settings-hint"> PostgreSQL {side.serverVersion}</small>}
    </div>
  )
}

export interface CloudSwitchDialogProps {
  inspection: CloudInspectionDto
  busy: boolean
  step?: string
  onConfirm(keep: DatabaseSide): void
  onCancel(): void
}

/**
 * O diálogo da troca local ↔ nuvem: o que cada lado tem e o que cada escolha faz.
 * O usuário escolhe qual lado manter; um lado vazio deixa o outro marcado. Ligar
 * mantendo os dados locais avisa se a nuvem foi usada por outro PC.
 */
export function CloudSwitchDialog({ inspection, busy, step, onConfirm, onCancel }: CloudSwitchDialogProps): JSX.Element {
  const [keep, setKeep] = useState<DatabaseSide | null>(inspection.suggested)
  const needsCloud = (side: DatabaseSide): boolean => inspection.action === 'ligar' || side === 'nuvem'
  const blocked = (side: DatabaseSide): boolean => needsCloud(side) && !inspection.cloud.reachable
  const overwritesCloud = inspection.action === 'ligar' && keep === 'local'
  return (
    <div className="cloud-switch-panel" role="dialog" aria-label={inspection.action === 'ligar' ? 'Ligar a nuvem' : 'Desligar a nuvem'}>
      <strong>{inspection.action === 'ligar' ? 'Ligar o PostgreSQL na nuvem' : 'Desligar o PostgreSQL na nuvem'}</strong>
      <div className="cloud-switch-sides">
        <SideCard title="Este PC (local)" side={inspection.local} />
        <SideCard title="Nuvem" side={inspection.cloud} />
      </div>
      <span>Qual lado manter?</span>
      {inspection.options.map((option) => (
        <label key={option.keep} className="cloud-switch-option">
          <input
            type="radio"
            name="cloud-switch-keep"
            checked={keep === option.keep}
            disabled={busy || blocked(option.keep)}
            onChange={() => setKeep(option.keep)}
          />
          <span>
            {option.keep === 'local' ? 'Manter os dados locais' : 'Manter os dados da nuvem'}
            <small>{option.description}</small>
          </span>
        </label>
      ))}
      {overwritesCloud && inspection.otherInstallations.length > 0 && (
        <span className="cloud-switch-warn">
          Outro PC usou esta nuvem em {when(inspection.otherInstallations[0].lastSeenAt)}. Manter os dados locais sobrescreve
          o que ele usa (com backup antes).
        </span>
      )}
      {overwritesCloud && inspection.olderCloudServer && (
        <span className="cloud-switch-warn">
          A nuvem roda um PostgreSQL mais antigo que o 18 do app: a cópia pode ser recusada — se for, nada muda.
        </span>
      )}
      <span className="settings-hint">
        Antes de sobrescrever um lado, o app faz backup dele. Nenhuma conversa pode estar no meio de um turno; durante a
        cópia, o que você fizer fica guardado e vai para o lado escolhido. O app reinicia ao terminar.
      </span>
      {busy && step && (
        <span className="settings-hint" role="status">
          {step}…
        </span>
      )}
      <div className="modal-actions">
        <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
        <button className="btn primary" type="button" disabled={busy || !keep || blocked(keep)} onClick={() => keep && onConfirm(keep)}>
          {busy ? 'Trocando…' : 'Confirmar'}
        </button>
      </div>
    </div>
  )
}
