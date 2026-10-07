import type { HandoffProjectAction } from '@shared/handoffProject'
import type { ProjectNotice } from './projectQueue'
import './projectQueue.css'

/**
 * O aviso da FILA DO PROJETO acima do campo de mensagem: o plano na fila
 * ("na fila do projeto (2º)"), a pasta suja, a resposta guardada e a decisão do
 * PO, com os botões fixos — ou, na conversa avulsa, o aviso de que uma
 * implantação roda na pasta. O texto vem pronto de projectQueue.ts.
 */
export function ProjectQueueNotice(props: {
  notice: ProjectNotice | null
  onAction(acao: HandoffProjectAction): void
  onOpenRecord?(path: string): void
}): JSX.Element | null {
  const { notice } = props
  if (!notice) return null
  return (
    <div className={`project-queue-notice ${notice.tone}`} role="status" aria-label="Fila do projeto">
      <div className="project-queue-notice-body">
        <span className="project-queue-notice-text">{notice.text}</span>
        {notice.detail && <span className="project-queue-notice-detail">{notice.detail}</span>}
      </div>
      {(notice.actions.length > 0 || (notice.registro && props.onOpenRecord)) && (
        <div className="project-queue-notice-actions">
          {notice.actions.map((action) => (
            <button key={action.acao} type="button" className="project-queue-notice-btn" onClick={() => props.onAction(action.acao)}>
              {action.label}
            </button>
          ))}
          {notice.registro && props.onOpenRecord && (
            <button type="button" className="project-queue-notice-link" onClick={() => props.onOpenRecord?.(notice.registro!)}>
              ver avaliação
            </button>
          )}
        </div>
      )}
    </div>
  )
}
