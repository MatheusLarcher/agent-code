import { IconCollapseRight, IconGlobe, IconUsers } from './Icons'

export type RightPane = 'browser' | 'agents'

interface Props {
  active: RightPane
  onSelect: (pane: RightPane) => void
  /** Collapses the whole right pane into the vertical rail. */
  onCollapse: () => void
  /** Subagents running right now — shown as a badge on the Agentes tab. */
  liveAgents: number
  /** Open preview tabs — shown as a small count on the Navegador tab. */
  browserTabs: number
}

/**
 * Segmented switch at the top of the right-hand pane: Navegador ⇄ Agentes.
 * Both panels live in the same slot, so this is the one place the user goes to
 * flip between them (the topbar button and the composer link only preselect).
 */
export function RightPaneTabs({ active, onSelect, onCollapse, liveAgents, browserTabs }: Props): JSX.Element {
  return (
    <div className="pane-tabs" role="tablist" aria-label="Painel da direita">
      <button
        type="button"
        role="tab"
        aria-selected={active === 'browser'}
        className={`pane-tab${active === 'browser' ? ' on' : ''}`}
        onClick={() => onSelect('browser')}
        title="Navegador / preview"
      >
        <IconGlobe size={14} />
        Navegador
        {browserTabs > 0 && <span className="pane-tab-count">{browserTabs}</span>}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'agents'}
        className={`pane-tab${active === 'agents' ? ' on' : ''}${liveAgents > 0 ? ' live' : ''}`}
        onClick={() => onSelect('agents')}
        title="Agentes: quem está trabalhando nesta conversa"
      >
        <IconUsers size={14} />
        Agentes
        {liveAgents > 0 && <span className="pane-tab-badge">{liveAgents}</span>}
      </button>
      <button type="button" className="nav-btn pane-collapse" onClick={onCollapse} title="Recolher painel">
        <IconCollapseRight />
      </button>
    </div>
  )
}
