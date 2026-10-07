import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentCodeApi } from '@shared/api'
import { moveBefore, nextPlans, type NextPlanView, type NextPromptView } from './nextPrompts'
import { useNextPrompts, type NextPromptsApi } from './useNextPrompts'
import './nextPrompts.css'

/**
 * A faixa "PRÓXIMOS PROMPTS" no painel do quadro, acima das colunas: os prompts
 * de implantação que esperam a vez, agrupados por plano. O nome não é "Fila"
 * (o app já usa "Na fila" na fila do chat e no registro de tarefas). Sem nada
 * esperando, a faixa some.
 *
 * Ações: arrastar (planos inteiros, ou os prompts DENTRO de um plano — nunca um
 * entre os de outro), Ver/editar, Tirar da fila, Enviar mesmo assim (o da
 * frente parado ou segurado), Começar mesmo assim (pasta suja) e Passar a vez
 * (mostra antes o que o plano parado deixou sem commit). Quem decide é o main.
 */

export type NextPromptsStripApi = NextPromptsApi &
  Pick<AgentCodeApi, 'handoffQueueEdit' | 'handoffQueueReorder' | 'handoffProjectReorder' | 'handoffProjectDirty' | 'handoffProjectAction' | 'openInFolder'>

interface Props {
  projectCwd: string
  conversationId: string
  wholeProject: boolean
  conversationTitles: Record<string, string>
  /** "Enviar mesmo assim": o despachante do App manda o próximo (gate com force). */
  onSendAnyway?(conversationId: string): void
  onOpenConversation?(conversationId: string): void
  /** Muda quando o aviso do chat pede para mostrar a faixa. */
  focus?: number
  /** O chip da autorização do PO (etapa da autorização), no cabeçalho. */
  headerExtra?: ReactNode
  api?: NextPromptsStripApi | null
}

type Modal =
  | { kind: 'editar'; prompt: NextPromptView; text: string }
  | { kind: 'tirar'; prompt: NextPromptView }
  | { kind: 'passar'; plan: NextPlanView; files: string[] | null }

type Drag = { kind: 'plan'; loteId: string } | { kind: 'prompt'; loteId: string; envioId: string }

const defaultApi = (): NextPromptsStripApi | null =>
  typeof window !== 'undefined' ? ((window as unknown as { api?: NextPromptsStripApi }).api ?? null) : null

export function NextPromptsStrip(props: Props): JSX.Element | null {
  const api = props.api === undefined ? defaultApi() : props.api
  const { items, snapshot, reload } = useNextPrompts(props.projectCwd, api)
  const plans = useMemo(
    () => nextPlans(items, snapshot, props.wholeProject ? {} : { conversationId: props.conversationId }),
    [items, snapshot, props.wholeProject, props.conversationId]
  )
  const [modal, setModal] = useState<Modal | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [flash, setFlash] = useState(false)
  const ref = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!props.focus) return
    ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1500)
    return () => clearTimeout(t)
  }, [props.focus])

  const total = plans.reduce((n, p) => n + p.prompts.length, 0)
  if (total === 0 || !api) return null

  async function run(call: () => Promise<{ ok: boolean; message?: string } | undefined>): Promise<boolean> {
    setError(null)
    try {
      const res = await call()
      if (res && !res.ok) {
        setError(res.message ?? 'A ação falhou.')
        return false
      }
      await reload()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  const promptAction = (plan: NextPlanView, prompt: NextPromptView, acao: string): void => {
    if (acao === 'editar') setModal({ kind: 'editar', prompt, text: prompt.item.conteudo })
    else if (acao === 'tirar' || acao === 'cancelar') setModal({ kind: 'tirar', prompt })
    else if (acao === 'enviar') props.onSendAnyway?.(plan.conversationId)
  }

  const planAction = async (plan: NextPlanView, acao: 'comecar' | 'passar'): Promise<void> => {
    if (acao === 'comecar') {
      await run(() => api.handoffProjectAction({ conversationId: plan.conversationId, acao: 'comecar' }))
      return
    }
    if (!plan.holderConversationId) return
    const dirty = await api.handoffProjectDirty({ conversationId: plan.holderConversationId }).catch(() => null)
    setModal({ kind: 'passar', plan, files: dirty && dirty.ok ? dirty.files : null })
  }

  const confirmModal = async (): Promise<void> => {
    if (!modal) return
    let ok = false
    if (modal.kind === 'editar') {
      ok = await run(() => api.handoffQueueEdit({ envioId: modal.prompt.item.envioId, acao: 'editar', conteudo: modal.text }))
    } else if (modal.kind === 'tirar') {
      ok = await run(() => api.handoffQueueEdit({ envioId: modal.prompt.item.envioId, acao: 'tirar' }))
    } else if (modal.plan.holderConversationId) {
      const holder = modal.plan.holderConversationId
      ok = await run(() => api.handoffProjectAction({ conversationId: holder, acao: 'passar' }))
    }
    if (ok) setModal(null)
  }

  const dropOnPlan = async (target: NextPlanView): Promise<void> => {
    const d = drag
    setDrag(null)
    if (d?.kind !== 'plan' || d.loteId === target.loteId) return
    const order = moveBefore(plans.map((p) => p.loteId), d.loteId, target.loteId)
    await run(() => api.handoffProjectReorder({ projectCwd: props.projectCwd, loteIds: order }))
  }

  const dropOnPrompt = async (plan: NextPlanView, target: NextPromptView): Promise<void> => {
    const d = drag
    setDrag(null)
    // Nunca um prompt de um plano entre os de outro.
    if (d?.kind !== 'prompt' || d.loteId !== plan.loteId || d.envioId === target.item.envioId) return
    const order = moveBefore(plan.prompts.map((p) => p.item.envioId), d.envioId, target.item.envioId)
    await run(() => api.handoffQueueReorder({ conversationId: plan.conversationId, envioIds: order }))
  }

  const planDraggable = props.wholeProject && plans.length > 1
  return (
    <section ref={ref} id="next-prompts" className={`next-prompts${flash ? ' flash' : ''}`} aria-label="Próximos prompts">
      <header className="next-prompts-head">
        <span className="next-prompts-title">Próximos prompts ({total})</span>
        {props.headerExtra}
      </header>
      {error && (
        <div className="next-prompts-error" role="alert">
          {error}
        </div>
      )}
      {plans.map((plan) => (
        <div
          key={plan.loteId}
          className={`next-plan${drag?.kind === 'plan' && drag.loteId === plan.loteId ? ' dragging' : ''}`}
          onDragOver={drag?.kind === 'plan' ? (e) => e.preventDefault() : undefined}
          onDrop={
            drag?.kind === 'plan'
              ? (e) => {
                  e.preventDefault()
                  void dropOnPlan(plan)
                }
              : undefined
          }
        >
          <div
            className="next-plan-head"
            draggable={planDraggable}
            onDragStart={planDraggable ? () => setDrag({ kind: 'plan', loteId: plan.loteId }) : undefined}
            onDragEnd={() => setDrag(null)}
            title={planDraggable ? 'Arraste para mudar a ordem dos planos' : undefined}
          >
            <span className="next-plan-title">{plan.header}</span>
            {plan.actions.map((acao) => (
              <button key={acao} type="button" className="next-btn" onClick={() => void planAction(plan, acao)}>
                {acao === 'comecar' ? 'Começar mesmo assim' : 'Passar a vez'}
              </button>
            ))}
          </div>
          {props.wholeProject && (
            <button type="button" className="next-plan-conv" onClick={() => props.onOpenConversation?.(plan.conversationId)}>
              {props.conversationTitles[plan.conversationId] ?? plan.conversationTitle}
            </button>
          )}
          {plan.note && (
            <div className="next-plan-note">
              {plan.note}
              {plan.registro && (
                <button type="button" className="next-link" onClick={() => void api.openInFolder(plan.registro!)}>
                  ver avaliação
                </button>
              )}
            </div>
          )}
          <ol className="next-prompt-list">
            {plan.prompts.map((prompt) => (
              <li
                key={prompt.item.envioId}
                className={`next-prompt${prompt.stopped ? ' stopped' : ''}${drag?.kind === 'prompt' && drag.envioId === prompt.item.envioId ? ' dragging' : ''}`}
                draggable={plan.prompts.length > 1}
                onDragStart={(e) => {
                  e.stopPropagation()
                  setDrag({ kind: 'prompt', loteId: plan.loteId, envioId: prompt.item.envioId })
                }}
                onDragEnd={() => setDrag(null)}
                onDragOver={drag?.kind === 'prompt' && drag.loteId === plan.loteId ? (e) => e.preventDefault() : undefined}
                onDrop={
                  drag?.kind === 'prompt'
                    ? (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        void dropOnPrompt(plan, prompt)
                      }
                    : undefined
                }
              >
                <span className="next-prompt-text">{prompt.text}</span>
                <span className={`next-prompt-state${prompt.stopped ? ' stopped' : ''}`}>{prompt.state}</span>
                <span className="next-prompt-actions">
                  {prompt.actions.map((acao) => (
                    <button key={acao} type="button" className="next-btn" onClick={() => promptAction(plan, prompt, acao)}>
                      {acao === 'enviar' ? 'Enviar mesmo assim' : acao === 'editar' ? 'Ver/editar' : acao === 'cancelar' ? 'Cancelar' : 'Tirar da fila'}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ))}
      {modal && (
        <div className="next-modal-overlay" onClick={() => setModal(null)}>
          <div className="next-modal" role="dialog" aria-label="Próximos prompts" onClick={(e) => e.stopPropagation()}>
            {modal.kind === 'editar' ? (
              <>
                <h3>{modal.prompt.text}</h3>
                <textarea
                  aria-label="Texto do prompt"
                  value={modal.text}
                  onChange={(e) => setModal({ ...modal, text: e.target.value })}
                  rows={14}
                />
              </>
            ) : modal.kind === 'tirar' ? (
              <p>
                Tirar da fila o {modal.prompt.text.split(' — ')[0]}? Ele não sai mais; o arquivo em <code>_handoff/</code> continua lá.
              </p>
            ) : (
              <>
                <p>
                  O plano "{modal.plan.holderTitulo}" para e o "{modal.plan.planTitulo}" ganha a vez.
                  {modal.files === null
                    ? ' Não deu para conferir a pasta (sem git).'
                    : modal.files.length === 0
                      ? ' A pasta está limpa.'
                      : ` O plano parado deixou ${modal.files.length === 1 ? '1 arquivo' : `${modal.files.length} arquivos`} sem commit:`}
                </p>
                {modal.files && modal.files.length > 0 && (
                  <ul className="next-modal-files">
                    {modal.files.slice(0, 50).map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                    {modal.files.length > 50 && <li>(+{modal.files.length - 50})</li>}
                  </ul>
                )}
              </>
            )}
            <div className="next-modal-actions">
              <button type="button" className="next-btn" onClick={() => setModal(null)}>
                Cancelar
              </button>
              <button type="button" className="next-btn primary" onClick={() => void confirmModal()}>
                {modal.kind === 'editar' ? 'Salvar' : modal.kind === 'tirar' ? 'Tirar da fila' : 'Passar a vez'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
