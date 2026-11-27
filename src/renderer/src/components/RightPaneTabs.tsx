import type { TaskCounts } from '@shared/stepProgress'
import { IconBoard, IconCollapseRight, IconPreview, IconScrum } from './Icons'

export type RightPane = 'board' | 'scrum' | 'preview'

interface Props {
  active: RightPane
  onSelect: (pane: RightPane) => void
  /** Collapses the whole right pane into the vertical rail. */
  onCollapse: () => void
  /** Subagents running right now — acende a aba Quadro, que é onde o elenco
   *  inteiro (executor por cartão, po/vigia/crítico/memória por coluna) vive. */
  liveAgents: number
  /** Progresso do quadro (concluídas/total, a contagem única taskCounts) e quantos cartões esperam você — `null` quando não há tarefa. */
  boardProgress: (Pick<TaskCounts, 'done' | 'total'> & { awaiting?: number }) | null
}

/**
 * Segmented switch at the top of the right-hand pane: Quadro ⇄ Scrum Master ⇄ Preview
 * (o Preview mostra sites, HTML e arquivos sem sair do app — ver preview/).
 * O navegador do agente não mora mais aqui — é uma janela do Chrome no PC. O
 * Quadro é o padrão; a aba Scrum Master mostra o mesmo Diário do Escritório 3D.
 * Dica de cada botão: o tooltip do app (`data-tip`), nunca o `title` nativo.
 */
export function RightPaneTabs({ active, onSelect, onCollapse, liveAgents, boardProgress }: Props): JSX.Element {
  const awaitingTip = boardProgress?.awaiting === 1 ? '1 cartão espera você' : `${boardProgress?.awaiting ?? 0} cartões esperam você`
  return (
    <div className="pane-tabs" role="tablist" aria-label="Painel da direita">
      <button
        type="button"
        role="tab"
        aria-selected={active === 'board'}
        className={`pane-tab${active === 'board' ? ' on' : ''}${liveAgents > 0 ? ' live' : ''}`}
        onClick={() => onSelect('board')}
        data-tip="As tarefas do projeto e quem está trabalhando em cada uma"
      >
        <IconBoard size={14} />
        Quadro
        {boardProgress && boardProgress.total > 0 && (
          <span className="pane-tab-count">{`${boardProgress.done}/${boardProgress.total}`}</span>
        )}
        {/* O que precisa de você (o que o contador da tela Entregas fazia). */}
        {!!boardProgress?.awaiting && (
          <span className="pane-tab-count awaiting" data-tip={awaitingTip}>
            {boardProgress.awaiting}
          </span>
        )}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'scrum'}
        className={`pane-tab${active === 'scrum' ? ' on' : ''}`}
        onClick={() => onSelect('scrum')}
        data-tip="O Diário do Scrum Master: as cobranças de hoje em todos os projetos"
      >
        <IconScrum size={14} />
        Scrum Master
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === 'preview'}
        className={`pane-tab${active === 'preview' ? ' on' : ''}`}
        onClick={() => onSelect('preview')}
        data-tip="Ver sites, páginas e arquivos sem sair do app"
      >
        <IconPreview size={14} />
        Preview
      </button>
      <button type="button" className="nav-btn pane-collapse" onClick={onCollapse} data-tip="Recolher painel" aria-label="Recolher painel">
        <IconCollapseRight />
      </button>
    </div>
  )
}
