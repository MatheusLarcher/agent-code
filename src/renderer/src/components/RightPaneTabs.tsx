import { IconBoard, IconCollapseRight, IconDatabase, IconGlobe } from './Icons'

export type RightPane = 'browser' | 'board' | 'tokens'

interface Props {
  active: RightPane
  onSelect: (pane: RightPane) => void
  /** Collapses the whole right pane into the vertical rail. */
  onCollapse: () => void
  /** Subagents running right now — acende a aba Quadro, que agora é onde o
   *  elenco inteiro (executor por cartão, po/vigia/crítico/memória por coluna)
   *  vive. */
  liveAgents: number
  /** Open preview tabs — shown as a small count on the Navegador tab. */
  browserTabs: number
  /** Progresso do quadro (concluídas/total) — `null` quando não há tarefa. */
  boardProgress: { done: number; total: number } | null
  /** Total de chamadas ao modelo na conversa ativa — contador da aba Tokens. */
  tokenCallCount: number
}

/**
 * Segmented switch at the top of the right-hand pane: Navegador ⇄ Quadro. A
 * aba "Agentes" foi fundida aqui dentro — o elenco de quem trabalha aparece
 * como bolinhas no próprio Quadro (por cartão para o executor, por cabeçalho
 * de coluna para po/vigia/crítico/memória), então um terceiro slot só para o
 * elenco virou redundante.
 */
export function RightPaneTabs({
  active,
  onSelect,
  onCollapse,
  liveAgents,
  browserTabs,
  boardProgress,
  tokenCallCount
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
        aria-selected={active === 'board'}
        className={`pane-tab${active === 'board' ? ' on' : ''}${liveAgents > 0 ? ' live' : ''}`}
        onClick={() => onSelect('board')}
        title="Quadro: as tarefas do projeto e quem está trabalhando em cada uma"
      >
        <IconBoard size={14} />
        Quadro
        {boardProgress && boardProgress.total > 0 && (
          <span className="pane-tab-count">{`${boardProgress.done}/${boardProgress.total}`}</span>
        )}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'tokens'}
        className={`pane-tab${active === 'tokens' ? ' on' : ''}`}
        onClick={() => onSelect('tokens')}
        title="Tokens: consumo de tokens desta conversa, por agente/subagente"
      >
        <IconDatabase size={14} />
        Tokens
        {tokenCallCount > 0 && <span className="pane-tab-count">{tokenCallCount}</span>}
      </button>
      <button type="button" className="nav-btn pane-collapse" onClick={onCollapse} title="Recolher painel">
        <IconCollapseRight />
      </button>
    </div>
  )
}
