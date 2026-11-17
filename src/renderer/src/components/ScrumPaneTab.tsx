/**
 * A aba "Scrum Master" do painel da direita: o MESMO Diário que abre ao clicar
 * no Scrum Master do Escritório 3D (ScrumPanel + useScrumPanel), agora a um
 * clique na aba Conversa. Este componente só é montado com a aba aberta, então
 * os dados só são lidos enquanto ela aparece.
 */
import { useProjectColorMap } from '../office/useProjectColors'
import { agentCss } from '../office3d/projectColor'
import { ScrumPanel } from '../office3d/scrum/ScrumPanel'
import { useScrumPanel } from '../office3d/scrum/useScrumPanel'

interface Props {
  /** O ✕ do Diário recolhe o painel da direita (aqui não há o que fechar). */
  onCollapse: () => void
  /** Abre a conversa do cartão no chat ao lado. */
  onOpenConversation: (convId: string) => void
  /** O 📍 do cartão: leva à mesa do agente, no Escritório. */
  onLocate: (convId: string) => void
  /** "Retomar com o aviso": manda o texto à conversa. */
  onSend?: (convId: string, text: string) => void
}

export function ScrumPaneTab({ onCollapse, onOpenConversation, onLocate, onSend }: Props): JSX.Element {
  const data = useScrumPanel()
  const projectColors = useProjectColorMap()
  return (
    <ScrumPanel
      embedded
      data={data}
      colorOf={(cwd) => agentCss({ projectColors }, cwd, `scrum:${cwd ?? ''}`)}
      onClose={onCollapse}
      onLocate={onLocate}
      onOpenConversation={onOpenConversation}
      onSend={onSend}
    />
  )
}
