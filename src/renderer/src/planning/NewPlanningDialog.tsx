/**
 * "Novo planejamento" de um projeto: cria na hora, SEM pedir nome — o plano
 * nasce "Sem nome" numa pasta plano-AAAAMMDD-HHMM (única contra os planos que
 * já existem) e o nome de verdade sai da primeira mensagem da conversa (ver
 * conversationTitle.ts). Continua listando os planos da pasta, para reabrir:
 * a conversa de um plano reaberto leva o título do roteiro dele
 * (existingPlanTitle), não o slug.
 *
 * Mesmo padrão de modal do app (.modal-overlay/.modal-card; Esc ou clique fora
 * fecha). Falha de IPC vira toast 'erro' — nada aqui lança.
 */
import './planningWorkspace.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { PlanningFailure } from '@shared/ipc'
import { IconSpinner } from '../components/Icons'
import { useUI } from '../ui/UiProvider'
import { IconPlanning } from './PlanningIcon'
import { existingPlanTitle, PLANNING_UNTITLED } from './planningConversation'
import { generatePlanningSlug } from './planningSlug'

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
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [creating, setCreating] = useState(false)
  /** Slug do plano existente cujo título está sendo lido para reabrir. */
  const [opening, setOpening] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

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
  const busy = creating || opening !== null
  // Com a lista ainda carregando o slug pode colidir; com ela em erro, o main
  // continua recusando duplicata (e isso vira toast).
  const canCreate = !busy && list.status !== 'loading'

  /** Reabre um plano existente com o título do roteiro dele ("Sem nome" vira
   *  título automático na 1ª mensagem); sem título legível, o slug. */
  const reopen = async (slug: string): Promise<void> => {
    if (busy) return
    setOpening(slug)
    const titulo = await existingPlanTitle(window.api, { projectCwd, slug })
    // Fechado (Esc/Cancelar) enquanto lia: o usuário desistiu, nada abre.
    if (!mounted.current) return
    onOpen(slug, titulo)
  }

  const create = async (): Promise<void> => {
    if (!canCreate) return
    // Gerado uma vez, no clique: é a pasta do plano e não muda mais.
    const slug = generatePlanningSlug(new Date(), existing)
    setCreating(true)
    try {
      const res = await window.api.planningCreate({ projectCwd, slug, titulo: PLANNING_UNTITLED })
      if (res.ok) {
        onOpen(slug, PLANNING_UNTITLED)
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
          Em <strong>{projectName}</strong>: o Agent Manager conversa com você para montar o roteiro e os cards. O
          nome do planejamento sai da sua primeira mensagem — dá para renomear depois.
        </p>
        <div className="modal-actions pl-new-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn primary"
            autoFocus
            disabled={!canCreate}
            onClick={() => void create()}
          >
            {creating ? 'Criando…' : 'Criar planejamento'}
          </button>
        </div>

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
                  <button
                    type="button"
                    className="pl-new-open"
                    disabled={busy}
                    onClick={() => void reopen(s)}
                    title={`Reabrir docs/spec/${s}/`}
                  >
                    <IconPlanning size={14} />
                    <span className="pl-new-open-slug">{s}</span>
                    <span className="pl-new-open-cta">{opening === s ? 'Abrindo…' : 'Abrir'}</span>
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
