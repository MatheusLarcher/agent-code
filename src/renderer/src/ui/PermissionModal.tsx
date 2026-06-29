import { useEffect } from 'react'
import type { PermissionRequest } from '@shared/ipc'
import { CountdownBar } from './CountdownBar'

interface Props {
  request: PermissionRequest
  onRespond: (behavior: 'allow' | 'deny', always: boolean) => void
}

/** Tool-permission request shown as a styled modal (replaces the old inline card). */
export function PermissionModal({ request, onRespond }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onRespond('deny', false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onRespond])

  const niceName = request.toolName.replace(/^mcp__browser__/, '🌐 ').replace(/^mcp__[^_]+__/, '')

  return (
    <div className="modal-overlay" onClick={() => onRespond('deny', false)}>
      <div
        className="modal-card permission-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal-title">Permitir ferramenta</h3>
        <p className="modal-message">
          O agente quer executar <strong>{niceName}</strong>.
        </p>
        <pre className="modal-pre">{JSON.stringify(request.input, null, 2).slice(0, 800)}</pre>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => onRespond('deny', false)}>
            Negar
          </button>
          <button className="btn" onClick={() => onRespond('allow', false)}>
            Permitir uma vez
          </button>
          <button className="btn primary" autoFocus onClick={() => onRespond('allow', true)}>
            Sempre permitir
          </button>
        </div>
        <CountdownBar deadline={request.deadline} />
      </div>
    </div>
  )
}
