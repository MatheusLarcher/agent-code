/**
 * HUD do Escritório 3D em tela cheia: a energia numa pílula de vidro no canto
 * superior esquerdo (SessionBattery), ao lado dela — com o Controle do Windows
 * ligado — o aviso "Controle do Windows ativo · Desativar" (o mesmo "Desativar"
 * do aviso do chat, que some com o chat minimizado) e, no canto direito, o
 * botão "?" com a legenda das teclas num popover. Tudo cabe na faixa de cima
 * que os balões não cruzam (speech.ts BUBBLE_TOP) e o chat maximizado não sobe
 * nela (OfficeChatFloat): nada do HUD fica sob o chat. A faixa não pega clique —
 * só a pílula, o aviso e o botão.
 *
 * Com a legenda aberta, Esc só fecha a legenda: o ouvinte é de captura e para a
 * propagação, então o Esc do motor (fechar a tela do monitor) não o recebe.
 */
import { useEffect, useRef, useState } from 'react'
import { IconWarning } from '../components/Icons'
import type { OfficePower } from './power'
import { SessionBattery } from './SessionBattery'

/** A legenda: teclas (ou gesto) → o que fazem. */
export const OFFICE_CONTROLS: ReadonlyArray<{ keys: readonly string[]; does: string }> = [
  { keys: ['W', 'A', 'S', 'D'], does: 'anda pelo escritório' },
  { keys: ['Shift'], does: 'corre (junto com WASD)' },
  { keys: ['Arrastar'], does: 'gira a câmera' },
  { keys: ['Roda'], does: 'aproxima e afasta' },
  { keys: ['Botão do meio'], does: 'arrasta a câmera' },
  { keys: ['Clique'], does: 'no agente: abre a tela do monitor dele' },
  { keys: ['Duplo clique'], does: 'no agente: a conversa dele no chat' },
  { keys: ['Esc'], does: 'fecha a tela e volta' },
  { keys: ['📍'], does: 'no chat: voa até a mesa do agente' }
]

export interface OfficeHudProps {
  power: OfficePower | null
  /** Controle do Windows ligado: mostra o aviso com o "Desativar". */
  windowsControlEnabled?: boolean
  onDisableWindowsControl?: () => void
}

export function OfficeHud({ power, windowsControlEnabled = false, onDisableWindowsControl }: OfficeHudProps): JSX.Element {
  const [help, setHelp] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // Aberta, a legenda fecha com Esc ou com um clique fora dela.
  useEffect(() => {
    if (!help) return
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || !box.current?.contains(e.target)) setHelp(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // O Esc é da legenda: não chega ao motor (que fecharia a tela do monitor).
      e.stopPropagation()
      setHelp(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [help])

  return (
    <div className="o3d-hud" data-testid="o3d-hud">
      <SessionBattery power={power} />
      {windowsControlEnabled && (
        <div className="o3d-glass o3d-winctl" role="status" data-testid="o3d-windows-control" title="O agente pode ver e controlar outros aplicativos deste computador.">
          <IconWarning size={13} className="o3d-winctl-icon" aria-hidden="true" />
          <span className="o3d-winctl-text">Controle do Windows ativo</span>
          {onDisableWindowsControl && (
            <>
              <span className="o3d-winctl-sep" aria-hidden="true">
                ·
              </span>
              <button type="button" className="o3d-winctl-off" onClick={onDisableWindowsControl}>
                Desativar
              </button>
            </>
          )}
        </div>
      )}
      <div className="o3d-help" ref={box}>
        <button
          type="button"
          className={`o3d-glass o3d-help-btn${help ? ' on' : ''}`}
          aria-expanded={help}
          aria-label="Controles do escritório"
          title="Controles do escritório"
          onClick={() => setHelp((v) => !v)}
        >
          ?
        </button>
        {help && (
          <div className="o3d-help-pop" role="dialog" aria-label="Controles do escritório">
            <div className="o3d-help-title">Controles</div>
            <dl className="o3d-keys">
              {OFFICE_CONTROLS.map(({ keys, does }) => (
                <div className="o3d-key-row" key={keys.join('+')}>
                  <dt>
                    {keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dt>
                  <dd>{does}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  )
}
