/**
 * "📋 Planejar" no Escritório (amb-iniciar-planejamento): o botão do HUD e o
 * clique na TV vazia abrem este formulário — o projeto (já com o filtrado, se
 * houver) e o pedido inicial. Quem cria é o App, pelo caminho de sempre (o
 * plano no main e a conversa de planejamento); a câmera voa para a TV.
 *
 * Mesmo padrão de modal do app (.modal-overlay/.modal-card); Esc ou clique fora fecha.
 */
import { useEffect, useState } from 'react'

export interface PlanProject {
  cwd: string
  name: string
}

export interface OfficePlanDialogProps {
  projects: readonly PlanProject[]
  /** O projeto já escolhido (o do filtro do HUD). */
  initialCwd: string | null
  onStart: (cwd: string, pedido: string) => void
  onClose: () => void
}

export function OfficePlanDialog({ projects, initialCwd, onStart, onClose }: OfficePlanDialogProps): JSX.Element {
  const [cwd, setCwd] = useState(initialCwd && projects.some((p) => p.cwd === initialCwd) ? initialCwd : (projects[0]?.cwd ?? ''))
  const [pedido, setPedido] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="o3d-plan-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (cwd) onStart(cwd, pedido.trim())
        }}
      >
        <h3 className="modal-title" id="o3d-plan-title">
          📋 Planejar
        </h3>
        {projects.length === 0 ? (
          <p className="o3d-plan-empty">Nenhum projeto ainda: abra uma conversa numa pasta de projeto e volte aqui.</p>
        ) : (
          <>
            <label className="o3d-plan-field">
              <span>Projeto</span>
              <select value={cwd} onChange={(e) => setCwd(e.target.value)} aria-label="Projeto">
                {projects.map((p) => (
                  <option key={p.cwd} value={p.cwd}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="o3d-plan-field">
              <span>Pedido inicial</span>
              <textarea autoFocus rows={4} value={pedido} onChange={(e) => setPedido(e.target.value)} placeholder="O que você quer planejar?" aria-label="Pedido inicial" />
            </label>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!cwd}>
            Planejar na TV
          </button>
        </div>
      </form>
    </div>
  )
}
