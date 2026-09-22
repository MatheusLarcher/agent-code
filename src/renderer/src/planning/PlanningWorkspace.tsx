/**
 * A Tela de Planejamento no lugar do workspace normal (chat + splitter +
 * painel da direita) quando a conversa ativa é de planejamento.
 *
 * O chat chega PRONTO (`chat`): é o mesmo <ChatPanel> que o App monta para
 * qualquer conversa, com as mesmas props — aqui ele só muda de lugar e vira a
 * coluna da direita da PlanningScreen. Nada de uma segunda lista de props.
 *
 * O cabeçalho mostra o modelo que o main anunciou para o Agent Manager e
 * guarda `headerActions` para o botão de enviar para implementação.
 */
import './planningWorkspace.css'
import type { ReactNode } from 'react'
import { managerModelLabel } from './planningConversation'
import { PlanningScreen } from './PlanningScreen'

export interface PlanningWorkspaceProps {
  /** Pasta do projeto (a `cwd` da conversa). */
  projectCwd: string
  /** Plano em docs/spec/<slug>/ (a `planningSlug` da conversa). */
  slug: string
  /** O painel de conversa com o Agent Manager. */
  chat: ReactNode
  /** Modelo em que a sessão do Manager subiu; null antes de ela subir. */
  managerModel: string | null
  /** Ações extras no cabeçalho, à direita do modelo (ex.: enviar para implementação). */
  headerActions?: ReactNode
}

function ManagerModel({ model }: { model: string | null }): JSX.Element {
  const label = model ? managerModelLabel(model) : 'definido ao iniciar'
  return (
    <span
      className={`pl-manager-model${model ? '' : ' pending'}`}
      title={
        model
          ? `A sessão do Agent Manager está rodando em ${label}. O modelo vem de Configurações → Planejamento.`
          : 'O modelo do Agent Manager é escolhido quando a sessão sobe (Configurações → Planejamento).'
      }
    >
      <span className="pl-manager-model-label">Modelo do Agent Manager</span>
      <span className="pl-manager-model-value" data-testid="pl-manager-model">
        {label}
      </span>
    </span>
  )
}

export function PlanningWorkspace({
  projectCwd,
  slug,
  chat,
  managerModel,
  headerActions
}: PlanningWorkspaceProps): JSX.Element {
  return (
    <div className="workspace planning-workspace">
      <PlanningScreen
        projectCwd={projectCwd}
        slug={slug}
        chatSlot={chat}
        headerActions={
          <>
            <ManagerModel model={managerModel} />
            {headerActions}
          </>
        }
      />
    </div>
  )
}
