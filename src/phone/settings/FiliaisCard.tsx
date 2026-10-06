/**
 * Configurações → conexão. No APK, o card "Filiais": uma linha por filial salva, com o nome editável, "em uso"
 * + endereço e token na ativa, e "Esquecer". No navegador (um PC só), o card "Conexão" de sempre.
 */
import { useState, type FormEvent } from 'react'
import { confirmForget, forgetLabel } from '../app/filiais'
import { client, toast } from '../app/runtime'
import { usePcs } from '../app/usePcs'
import { MAX_NAME, pcLabel, renamePc, type PcList, type SavedPc } from '../core/pcs'
import { useStore } from '../core/store'

/** O endereço em uso (LAN ou relay, sem http/https) e o token da conexão: as linhas de sempre. */
function AddressRows(): JSX.Element {
  const base = useStore(client.store, (s) => s.base)
  const token = useStore(client.store, (s) => s.token)
  return (
    <>
      <div className="cfg-row"><span className="cfg-k">Endereço</span><span className="cfg-v">{base ? base.replace(/^https?:\/\//, '') : '—'}</span></div>
      <div className="cfg-row"><span className="cfg-k">Token</span><span className="cfg-v">{token || '—'}</span></div>
    </>
  )
}

function FilialRow({ pc, list }: { pc: SavedPc; list: PcList }): JSX.Element {
  const active = pc.id === list.activeId
  // null = não está editando: o campo mostra o nome salvo, que também muda por fora (o hostname que chega ao conectar).
  const [draft, setDraft] = useState<string | null>(null)
  const typed = draft?.trim() ?? ''
  const canSave = draft !== null && typed !== '' && typed !== (pc.nome ?? '')
  const save = (e: FormEvent): void => {
    e.preventDefault() // Enter no campo cai aqui (formulário), com o mesmo bloqueio do botão
    if (!canSave) return
    if (renamePc(pc.id, typed)) toast('Filial renomeada', 'sucesso')
    else toast('Não foi possível renomear a filial', 'erro') // a filial deixou de existir enquanto o painel estava aberto
    setDraft(null)
  }
  const label = pcLabel(pc, list)
  return (
    <div className="cfg-filial" role="group" aria-label={label}>
      {active && <span className="cfg-badge">em uso</span>}
      <form className="cfg-name-form" onSubmit={save}>
        <input
          className="cfg-input"
          type="text"
          value={draft ?? pc.nome ?? ''}
          placeholder={pc.nome === null ? label : 'Nome da filial'}
          maxLength={MAX_NAME}
          aria-label="Nome da filial"
          autoComplete="off"
          enterKeyHint="done"
          onChange={(e) => setDraft(e.currentTarget.value)}
        />
        <button type="submit" className="cfg-save" disabled={!canSave}>
          Salvar
        </button>
      </form>
      {active && <AddressRows />}
      <button type="button" className="cfg-exit cfg-exit-sm" title={`Esquecer a filial ${label}`} onClick={() => confirmForget(pc.id)}>
        Esquecer
      </button>
    </div>
  )
}

/** O card "Filiais" (APK). */
export function FiliaisCard(): JSX.Element {
  const list = usePcs()
  return (
    <section className="cfg-card">
      <div className="cfg-card-title">Filiais</div>
      {list.pcs.length === 0 && <span className="cfg-desc">Nenhuma filial salva.</span>}
      {list.pcs.map((pc) => (
        <FilialRow key={pc.id} pc={pc} list={list} />
      ))}
    </section>
  )
}

/** O card "Conexão" de sempre (navegador): endereço, token e a saída, com o rótulo da regra de esquecer. */
export function ConexaoCard(): JSX.Element {
  const list = usePcs()
  return (
    <section className="cfg-card">
      <div className="cfg-card-title">Conexão</div>
      <AddressRows />
      <button type="button" className="cfg-exit" onClick={() => confirmForget()}>
        {forgetLabel(list)}
      </button>
    </section>
  )
}
