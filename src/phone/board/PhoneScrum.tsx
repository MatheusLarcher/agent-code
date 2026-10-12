/**
 * O "Diário do Scrum Master" do PC em tela cheia no celular (ScrumPanel +
 * useScrumPanel pelo `window.api` da ponte). Só monta aberto: o hook lê ao
 * montar e assina o `scrum:changed`. O 📍 leva à aba Escritório; "abrir" leva à
 * conversa; "Retomar com o aviso" manda o texto pela ponte (/api/send).
 */
import { reserveProjectColor } from '@shared/projectColor'
import { ScrumPanel } from '@renderer/office3d/scrum/ScrumPanel'
import { useScrumPanel } from '@renderer/office3d/scrum/useScrumPanel'
import { client, openConversation, openTab, toast } from '../app/runtime'
import { errorText } from '../core/net'
import { useStore } from '../core/store'
import { PhoneUiProvider } from '../office/PhoneUiProvider'

function Panel({ onClose }: { onClose: () => void }): JSX.Element {
  const data = useScrumPanel()
  const colors = useStore(client.store, (s) => s.projectColors)
  return (
    <ScrumPanel
      data={data}
      colorOf={(cwd) => (cwd ? (colors?.[cwd]?.hex ?? reserveProjectColor(cwd)) : 'var(--faint)')}
      onClose={onClose}
      onLocate={() => {
        onClose()
        openTab('escritorio')
      }}
      onOpenConversation={(convId) => {
        onClose()
        openConversation(convId)
      }}
      onSend={(convId, text) => {
        client
          .post('/api/send', { convId, text, images: [], files: [] }, 60000)
          .then(() => toast('Aviso enviado à conversa.', 'sucesso'))
          .catch((err: unknown) => toast(errorText(err), 'erro'))
      }}
    />
  )
}

export function PhoneScrum({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <div className="bd-scrum">
      <PhoneUiProvider>
        <Panel onClose={onClose} />
      </PhoneUiProvider>
    </div>
  )
}
