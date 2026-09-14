import { IconBoard, IconCollapseRight, IconGlobe, IconUsers } from './Icons'

export type RightPane = 'browser' | 'agents' | 'board'

interface Props {
  active: RightPane
  onSelect: (pane: RightPane) => void
  /** Collapses the whole right pane into the vertical rail. */
  onCollapse: () => void
  /** Subagents running right now — shown as a badge on the Agentes tab. */
  liveAgents: number
  /** Open preview tabs — shown as a small count on the Navegador tab. */
  browserTabs: number
  /** Progresso do quadro (concluídas/total) — `null` quando não há tarefa. */
  boardProgress: { done: number; total: number } | null
}

/**
 * Segmented switch at the top of the right-hand pane: Navegador ⇄ Agentes ⇄
 * Quadro. Os três painéis dividem o mesmo slot, então este é o único lugar onde
 * o usuário alterna (o botão da topbar e o link do composer só pré-selecionam).
 */
export function RightPaneTabs({
  active,
  onSelect,
  onCollapse,
  liveAgents,
  browserTabs,
  boardProgress
}: Props): JSX.Element {
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
      <button
        type="button"
        role="tab"
        aria-selected={active === 'board'}
        className={`pane-tab${active === 'board' ? ' on' : ''}`}
        onClick={() => onSelect('board')}
        title="Quadro: as tarefas do projeto, marcadas sozinhas conforme o agente conclui"
      >
        <IconBoard size={14} />
        Quadro
        {boardProgress && boardProgress.total > 0 && (
          <span className="pane-tab-count">{`${boardProgress.done}/${boardProgress.total}`}</span>
        )}
      </button>
      <button type="button" className="nav-btn pane-collapse" onClick={onCollapse} title="Recolher painel">
        <IconCollapseRight />
      </button>
    </div>
  )
}
