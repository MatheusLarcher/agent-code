import { useEffect, useState } from 'react'
import { useUI } from './UiProvider'

type Status = { set: boolean; cloud: boolean; pendingRestore: boolean }

/**
 * Frase-senha do cofre (Configurações › Dados). Com o banco na nuvem, o cofre só
 * vai para o banco cifrado por ela; em outro PC, é ela que abre o cofre de novo.
 * A frase não é guardada em lugar nenhum: este PC guarda só a chave que sai dela,
 * selada pelo sistema.
 */
export function VaultPassphraseField(): JSX.Element | null {
  const { notify } = useUI()
  const [status, setStatus] = useState<Status | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void window.api.vaultPassphraseStatus?.().then(setStatus).catch(() => setStatus(null))
  }, [])

  if (!status) return null

  const save = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const result = await window.api.setVaultPassphrase(value).catch((e: unknown) => ({ ok: false as const, error: String(e) }))
    setBusy(false)
    if (!result.ok) return setError(result.error)
    setValue('')
    setStatus(await window.api.vaultPassphraseStatus())
    notify('sucesso', 'Frase-senha do cofre salva neste computador.')
  }

  return (
    <div className="settings-field" data-testid="vault-passphrase">
      <span className="settings-field-label">Frase-senha do cofre</span>
      <span className="settings-hint">
        {status.pendingRestore
          ? 'O cofre que está na nuvem está protegido. Digite a frase-senha para abri-lo neste computador.'
          : status.set
            ? 'Definida neste computador. O cofre vai para o banco cifrado por ela.'
            : status.cloud
              ? 'Com o banco na nuvem, o cofre só fica neste computador até você criar uma frase-senha. Com ela, ele vai cifrado para a nuvem e abre em outro PC.'
              : 'Opcional com o banco local. Com ela, o cofre vai cifrado para o banco e abre em outro PC.'}{' '}
        <strong>Se esquecer a frase, as senhas do cofre não abrem em outro PC.</strong>
      </span>
      {(!status.set || status.pendingRestore) && (
        <form
          className="settings-row"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <input
            className="settings-input"
            type="password"
            autoComplete="new-password"
            placeholder="Pelo menos 12 caracteres"
            aria-label="Frase-senha do cofre"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button className="btn" type="submit" disabled={busy || value.trim().length < 12}>
            {busy ? 'Salvando…' : status.pendingRestore ? 'Abrir o cofre' : 'Salvar frase-senha'}
          </button>
        </form>
      )}
      {error && (
        <span className="settings-hint" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
