/**
 * Pedaços do Office3DWorkspace que ficam aqui para ele caber nas 500 linhas:
 * o clique no PO (o "Fala, PO" do projeto dele no chat flutuante, em vez da
 * tela de um monitor) e o rodapé da tela do monitor focado.
 */
import type { ReactNode } from 'react'
import { poChatOpen } from '../poChat/poChatOpen'
import type { Office3DEngine } from './engine'

/**
 * Clique no PO (ao lado do quadro): abre o "Fala, PO" do projeto dele — a pasta da
 * conversa que o representa — e fecha o foco do motor (a câmera fica perto dele, sem
 * tela de monitor). false se `key` não é o PO.
 */
export function openPoChat(engine: Office3DEngine | null, key: string): boolean {
  const c = engine?.scene.character(key)
  const cwd = c?.spot === 'po' ? engine?.currentFeed?.conversations.find((x) => x.id === c.model.convId)?.cwd : null
  if (!engine || !cwd) return false
  engine.leaveFocus(false)
  poChatOpen.set(cwd)
  return true
}

/** O rodapé da tela do monitor: o seletor de modelo/esforço do agente focado e o campo de digitar (só com a conversa dele ativa). */
export function screenComposerOf(picker: ReactNode, field: ReactNode): ReactNode {
  if (!picker && !field) return null
  return (
    <>
      {picker ? (
        <div className="composer-bar cm-model-bar" data-testid="office-screen-model">
          {picker}
        </div>
      ) : null}
      {field}
    </>
  )
}
