/**
 * "+ Novo planejamento": projeto (um que o PC conhece) + o pedido. O PC cria a
 * conversa do Agent Manager (o mesmo startOfficePlan do PC) e o celular a abre.
 */
import { useMemo, useState } from 'react'
import { MAX_REMOTE_PLAN_PEDIDO } from '@shared/planningRemote'
import { client } from '../app/runtime'
import { basename } from '../core/format'
import { toPlanningError } from '../core/planning'
import { useStore } from '../core/store'
import { Icon } from '../ui/icons'
import { cancelCreate, knownProjects, planUi, submitCreate } from './planState'

export function NewPlanSheet(): JSX.Element | null {
  const creating = useStore(planUi, (s) => s.creating)
  const projects = useStore(client.store, (s) => s.projects)
  const conversations = useStore(client.store, (s) => s.conversations)
  const lists = useStore(planUi, (s) => s.lists)
  // Projetos cuja pasta não existe neste PC (a lista voltou not_found) não entram: a ponte recusaria.
  const cwds = useMemo(() => {
    const all = knownProjects(projects, conversations)
    const usable = all.filter((p) => !lists[p]?.hidden)
    return usable.length ? usable : all
  }, [projects, conversations, lists])
  const [cwd, setCwd] = useState(creating?.cwd && cwds.includes(creating.cwd) ? creating.cwd : cwds[0] || '')
  const [pedido, setPedido] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!creating) return null

  const submit = (): void => {
    if (!cwd || sending) return
    setSending(true)
    setError(null)
    submitCreate(cwd, pedido).catch((e) => {
      setSending(false)
      setError(toPlanningError(e).message)
    })
  }

  return (
    <div className="modal-overlay" onClick={cancelCreate}>
      <form
        className="modal-card pl-sheet pl-new-sheet"
        role="dialog"
        aria-label="Novo planejamento"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="pl-sheet-head">
          <strong className="pl-sheet-title">Novo planejamento</strong>
          <button type="button" className="icon-btn pl-sheet-x" aria-label="Fechar" onClick={cancelCreate}>
            <Icon name="x" size={20} />
          </button>
        </div>
        <div className="pl-sheet-body">
          <label className="pl-field">
            <span>Projeto</span>
            <select value={cwd} onChange={(e) => setCwd(e.currentTarget.value)}>
              {cwds.map((p) => (
                <option key={p} value={p}>{basename(p)}</option>
              ))}
            </select>
          </label>
          <label className="pl-field">
            <span>O que você quer planejar?</span>
            <textarea
              rows={5}
              maxLength={MAX_REMOTE_PLAN_PEDIDO}
              placeholder="Ex.: tela de login com SSO e recuperação de senha"
              value={pedido}
              onChange={(e) => setPedido(e.currentTarget.value)}
            />
          </label>
          <p className="pl-hint">O Agent Manager começa a conversa no PC; ela abre aqui em seguida.</p>
          {error && <p className="pl-row-err">{error}</p>}
        </div>
        <div className="pl-sheet-actions">
          <button type="submit" className="btn primary big" disabled={!cwd || sending}>
            {sending ? <span className="spinner" /> : <Icon name="plus" size={18} />} Criar planejamento
          </button>
        </div>
      </form>
    </div>
  )
}
