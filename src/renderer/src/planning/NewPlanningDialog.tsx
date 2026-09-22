/**
 * "Novo planejamento" de um projeto: título → slug (derivado e único contra os
 * planos que já existem na pasta) e a lista desses planos, para reabrir.
 *
 * Mesmo padrão de modal do app (.modal-overlay/.modal-card; Esc ou clique fora
 * fecha). Falha de IPC vira toast 'erro' — nada aqui lança.
 */
import './planningWorkspace.css'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { PlanningFailure } from '@shared/ipc'
import { IconSpinner } from '../components/Icons'
import { useUI } from '../ui/UiProvider'
import { IconPlanning } from './PlanningIcon'
import { derivePlanningSlug } from './planningSlug'

export interface NewPlanningDialogProps {
  projectCwd: string
  /** Nome curto do projeto, para o texto do diálogo. */
  projectName: string
  /** Um plano pronto para abrir: o recém-criado (com o título) ou um existente. */
  onOpen: (slug: string, titulo?: string) => void
  onClose: () => void
}

type ListState = { status: 'loading' } | { status: 'ready'; slugs: string[] } | { status: 'error' }

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function failureText(f: PlanningFailure): string {
  return f.code === 'rev_conflict' ? 'conflito de versão' : f.message
}

export function NewPlanningDialog({ projectCwd, projectName, onOpen, onClose }: NewPlanningDialogProps): JSX.Element {
  const { notify } = useUI()
  const [titulo, setTitulo] = useState('')
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    setList({ status: 'loading' })
    const fail = (why: string): void => {
      setList({ status: 'error' })
      notify('erro', `Não consegui listar os planejamentos: ${why}`)
    }
    void (async () => {
      try {
        const res = await window.api.planningList({ projectCwd })
        if (!alive) return
        if (res.ok) setList({ status: 'ready', slugs: [...res.slugs].sort() })
        else fail(failureText(res))
      } catch (err) {
        if (alive) fail(errText(err))
      }
    })()
    return () => {
      alive = false
    }
  }, [projectCwd, notify])

  const existing = useMemo(() => (list.status === 'ready' ? list.slugs : []), [list])
  const slug = useMemo(() => derivePlanningSlug(titulo, existing), [titulo, existing])
  // Com a lista ainda carregando o slug pode colidir; com ela em erro, o main
  // continua recusando duplicata (e isso vira toast).
  const canCreate = !!slug && !creating && list.status !== 'loading'

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!canCreate) return
    const name = titulo.trim()
    setCreating(true)
    try {
      const res = await window.api.planningCreate({ projectCwd, slug, titulo: name })
      if (res.ok) {
        onOpen(slug, name)
        return
      }
      notify('erro', `Não consegui criar o planejamento: ${failureText(res)}`)
    } catch (err) {
      notify('erro', `Não consegui criar o planejamento: ${errText(err)}`)
    }
    setCreating(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-card pl-new-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pl-new-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title" id="pl-new-title">
          Novo planejamento
        </h3>
        <p className="modal-message">
          Em <strong>{projectName}</strong>: o Agent Manager conversa com você para montar o roteiro e os cards.
        </p>
        <form className="pl-new-form" onSubmit={(e) => void create(e)}>
          <label className="pl-new-label" htmlFor="pl-new-titulo">
            Título
          </label>
          <input
            id="pl-new-titulo"
            className="pl-new-input"
            autoFocus
            value={titulo}
            maxLength={200}
            placeholder="Ex.: Checkout com Pix"
            onChange={(e) => setTitulo(e.target.value)}
          />
          <div className="pl-new-slug" aria-live="polite">
            {slug ? (
              <>
                Pasta do plano: <code data-testid="pl-new-slug">docs/spec/{slug}/</code>
              </>
            ) : titulo.trim() ? (
              'Use ao menos uma letra ou número no título.'
            ) : (
              'A pasta do plano sai do título.'
            )}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="btn primary" disabled={!canCreate}>
              {creating ? 'Criando…' : 'Criar planejamento'}
            </button>
          </div>
        </form>

        <section className="pl-new-existing" aria-label="Planejamentos desta pasta">
          <h4 className="pl-new-existing-title">Já existem nesta pasta</h4>
          {list.status === 'loading' && (
            <div className="pl-new-state" role="status">
              <IconSpinner className="spinner" size={13} /> Carregando…
            </div>
          )}
          {list.status === 'error' && <div className="pl-new-state">Não consegui listar os planejamentos.</div>}
          {list.status === 'ready' && list.slugs.length === 0 && (
            <div className="pl-new-state">Nenhum planejamento ainda.</div>
          )}
          {list.status === 'ready' && list.slugs.length > 0 && (
            <ul className="pl-new-list">
              {list.slugs.map((s) => (
                <li key={s}>
                  <button type="button" className="pl-new-open" onClick={() => onOpen(s)} title={`Reabrir docs/spec/${s}/`}>
                    <IconPlanning size={14} />
                    <span className="pl-new-open-slug">{s}</span>
                    <span className="pl-new-open-cta">Abrir</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
