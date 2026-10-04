/**
 * "← Central": no topo de uma conversa aberta pela Central (aviso, resposta,
 * trilho), volta para ela. Quem decide quando aparece é o App (prop do ChatPanel).
 */
import { IconArrowLeft } from '../components/Icons'
import './centralFeed.css'

export function CentralBackButton({ onBack }: { onBack: () => void }): JSX.Element {
  return (
    <button type="button" className="central-back" title="Voltar para a Central" aria-label="Voltar para a Central" onClick={onBack}>
      <IconArrowLeft size={13} />
      Central
    </button>
  )
}
