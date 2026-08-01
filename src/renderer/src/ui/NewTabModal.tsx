import { useEffect } from 'react'
import { TAB_KINDS, type TabKind } from '@shared/ipc'
import { TabIcon } from '../components/TabIcon'

interface Props {
  /** Called with the chosen kind (only implemented kinds are clickable). */
  onPick: (kind: TabKind) => void
  onClose: () => void
}

const DESCRIPTIONS: Record<TabKind, string> = {
  web: 'Um navegador headless completo para testar páginas web ou investigar URLs na internet.',
  android:
    'Um emulador/dispositivo Android real rodando no computador. O agente pode instalar e testar aplicativos.',
  iphone: 'Simulador do iOS. Em breve!',
  file: 'Visualizador de arquivos do projeto: Markdown, PDF, imagens, planilhas (xlsx/csv) e código.'
}

// Implemented kinds come first; "em breve" ones (e.g. iPhone) sink to the
// bottom (sort is stable).
const MANUAL_KINDS = (Object.keys(TAB_KINDS) as TabKind[])
  .sort((a, b) => Number(TAB_KINDS[b].implemented) - Number(TAB_KINDS[a].implemented))

/** Centered modal to choose what kind of preview tab to open. Rendered at the app
 *  root so it is never clipped by the tab strip (which scrolls horizontally). */
export function NewTabModal({ onPick, onClose }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card newtab-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Nova aba de preview</h3>
        <p className="modal-message">Escolha o tipo de preview que deseja abrir.</p>
        <div className="newtab-options">
          {MANUAL_KINDS.map((k) => {
            const meta = TAB_KINDS[k]
            return (
              <button
                key={k}
                className="newtab-option"
                disabled={!meta.implemented}
                onClick={() => meta.implemented && onPick(k)}
              >
                <span className="newtab-option-ico">
                  <TabIcon kind={k} size={22} />
                </span>
                <span className="newtab-option-text">
                  <span className="newtab-option-title">
                    {meta.display}
                    {!meta.implemented && <span className="soon">em breve</span>}
                  </span>
                  <span className="newtab-option-desc">{DESCRIPTIONS[k]}</span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}
