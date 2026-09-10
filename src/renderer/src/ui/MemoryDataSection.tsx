import { useCallback, useEffect, useState } from 'react'
import type { MemoryConflictItem, SecretVaultItem } from '@shared/ipc'
import { useUI } from './UiProvider'
import { IconKey, IconWarning } from '../components/Icons'

/** Short, local date for a stored timestamp; falls back to the raw string. */
function when(iso: string): string {
  const date = new Date(iso)
  return Number.isFinite(date.valueOf()) ? date.toLocaleString() : iso
}

const OP_LABEL: Record<MemoryConflictItem['op'], string> = {
  create: 'criar',
  update: 'atualizar',
  retire: 'aposentar'
}

/**
 * Configurações → Dados: the encrypted secret vault and the memory proposals
 * that did not apply. Both exist so nothing about memory is silent — a refused
 * save has to be visible somewhere, and a stored credential has to be listable
 * and removable. The vault VALUE is never sent to the renderer; only names.
 */
export function MemoryDataSection(): JSX.Element {
  const { notify, confirm } = useUI()
  const [vaultEnabled, setVaultEnabled] = useState(true)
  const [secrets, setSecrets] = useState<SecretVaultItem[]>([])
  const [conflicts, setConflicts] = useState<MemoryConflictItem[]>([])
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const [config, list, failed] = await Promise.all([
      window.api.getConfig(),
      window.api.listSecrets().catch(() => [] as SecretVaultItem[]),
      window.api.listMemoryConflicts().catch(() => [] as MemoryConflictItem[])
    ])
    setVaultEnabled(config.secretVaultEnabled)
    setSecrets(list)
    setConflicts(failed)
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Applies immediately, like the other permission switches: turning access off
  // has to take effect now, not when the user remembers to press Salvar.
  const toggleVault = async (on: boolean): Promise<void> => {
    setVaultEnabled(on)
    try {
      await window.api.setConfig({ secretVaultEnabled: on })
      notify(
        'sucesso',
        on ? 'O agente pode ler e gravar no cofre.' : 'Acesso do agente ao cofre desligado. As chaves guardadas continuam salvas.'
      )
    } catch (error) {
      setVaultEnabled(!on)
      notify('erro', `Não foi possível alterar o cofre: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const removeSecret = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: 'Apagar do cofre',
      message: `Apagar "${name}" do cofre? As memórias que citam esse nome ficam com o marcador sem valor. Isso não revoga a credencial no serviço.`,
      confirmLabel: 'Apagar',
      danger: true
    })
    if (!ok) return
    try {
      await window.api.deleteSecret(name)
      setSecrets((current) => current.filter((item) => item.name !== name))
      notify('sucesso', `"${name}" apagado do cofre.`)
    } catch (error) {
      notify('erro', `Não foi possível apagar: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const discard = async (item: MemoryConflictItem): Promise<void> => {
    try {
      await window.api.discardMemoryProposal(item.id)
      setConflicts((current) => current.filter((entry) => entry.id !== item.id))
    } catch (error) {
      notify('erro', `Não foi possível descartar: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <>
      <section className={`settings-section settings-switch-section ${vaultEnabled ? 'on' : ''}`}>
        <label className="settings-switch-row">
          <span className="settings-switch-text">
            <strong>
              <IconKey size={15} /> Cofre de chaves do agente
            </strong>
            <span className="settings-desc">
              Quando o agente salva uma memória com chave, token ou senha, o valor vai para um cofre
              criptografado desta máquina e o texto guarda só um marcador. Ligado, o agente pode ler o
              valor de volta para executar a tarefa. Desligado, ele não lê nem grava — as chaves já
              guardadas continuam salvas. Isso não apaga um valor que já foi enviado ao modelo antes.
            </span>
          </span>
          <input
            className="switch-input"
            type="checkbox"
            checked={vaultEnabled}
            onChange={(event) => void toggleVault(event.target.checked)}
          />
          <span className="switch-visual" aria-hidden="true" />
        </label>

        <div className="settings-list">
          {!loaded && <span className="settings-hint">Carregando…</span>}
          {loaded && !secrets.length && <span className="settings-hint">Nenhuma chave guardada.</span>}
          {secrets.map((item) => (
            <div className="settings-list-row" key={item.name}>
              <span className="settings-list-main" title={item.name}>
                {item.name}
              </span>
              <span className="settings-list-meta">{when(item.updatedAt)}</span>
              <button className="btn ghost" type="button" onClick={() => void removeSecret(item.name)}>
                Apagar
              </button>
            </div>
          ))}
        </div>
      </section>

      {loaded && conflicts.length > 0 && (
        <section className="settings-section">
          <span className="settings-field-label">
            <IconWarning size={15} /> Memórias que não foram salvas
          </span>
          <span className="settings-hint">
            Estas propostas não puderam ser aplicadas — normalmente porque a memória mudou entre a leitura
            e a gravação. O agente pode refazê-las; descartar só limpa a lista.
          </span>
          <div className="settings-list">
            {conflicts.map((item) => (
              <div className="settings-list-row" key={item.id}>
                <span className="settings-list-main" title={item.reason ?? ''}>
                  {OP_LABEL[item.op]} {item.relPath}
                  {item.reason ? <span className="settings-list-reason"> — {item.reason}</span> : null}
                </span>
                <span className="settings-list-meta">{when(item.updatedAt)}</span>
                <button className="btn ghost" type="button" onClick={() => void discard(item)}>
                  Descartar
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
