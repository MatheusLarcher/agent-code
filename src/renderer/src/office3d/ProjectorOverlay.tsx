/**
 * O telão grande do projetor (clique na tela acesa de uma sala): a mesma
 * imagem do projetor — a janela do navegador ou o celular, com a página da
 * conversa —, grande, com a URL, o selo ao vivo e o botão que leva à aba
 * Conversa com o navegador dessa conversa. Quem desenha no canvas daqui é o
 * motor (Projectors.mirror), junto com a textura da sala e no mesmo ritmo
 * (no máximo ~5 por segundo). Esc ou clicar fora fecha.
 */
import { useEffect } from 'react'
import type { ProjectorInfo } from './projectors'
import { PROJ_H, PROJ_W } from './projectorPaint'
import './screens.css'

export interface ProjectorOverlayProps {
  info: ProjectorInfo
  /** Liga (canvas) e desliga (null) o telão como espelho do projetor da sala. */
  mirror: (canvas: HTMLCanvasElement | null) => void
  onClose: () => void
  /** Leva à aba Conversa com o navegador da conversa; sem ele, sem o botão. */
  onShowBrowser?: (convId: string) => void
}

export function ProjectorOverlay({ info, mirror, onClose, onShowBrowser }: ProjectorOverlayProps): JSX.Element {
  // Esc fecha só o telão (fase de captura: nem a tela do monitor nem o chat recebem).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const where = info.kind === 'android' ? info.title || 'Android' : info.url || info.title || 'Navegador'
  return (
    <div
      className="o3d-projector"
      role="dialog"
      aria-label="Telão do projetor"
      data-testid="o3d-projector"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="o3d-projector-card">
        <div className="o3d-projector-head">
          <span className={`o3d-projector-live${info.live ? ' on' : ''}`}>{info.live ? '● AO VIVO' : 'último quadro'}</span>
          <span className="o3d-projector-where" title={where}>
            {info.kind === 'android' ? `📱 ${where}` : where}
          </span>
          {info.project && <span className="o3d-chat-project">{info.project}</span>}
          {onShowBrowser && (
            <button type="button" className="o3d-projector-open" onClick={() => onShowBrowser(info.convId)}>
              Abrir na aba Conversa
            </button>
          )}
          <button type="button" className="o3d-turn-close" onClick={onClose} aria-label="Fechar o telão" title="Fechar (Esc)">
            ×
          </button>
        </div>
        <canvas ref={mirror} className="o3d-projector-canvas" width={PROJ_W * 2} height={PROJ_H * 2} data-testid="o3d-projector-canvas" />
      </div>
    </div>
  )
}
