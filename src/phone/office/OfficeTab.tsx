/**
 * A aba Escritório do celular: o MESMO escritório 3D do PC (Office3DWorkspace +
 * motor), com o feed montado da ponte (phoneFeed.ts) e os modelos/animações
 * baixados do PC (`/api/office-agent`). Fica montada depois da 1ª abertura e
 * pausa fora da aba (o motor para o laço), como a aba do PC.
 *
 * Toque: arrastar move, dois dedos dão zoom e giram, toque no agente abre o
 * monitor dele; a faixa de baixo leva ao chat da conversa escolhida.
 *
 * Os componentes do PC montados aqui pedem o `UiContext` (PhoneUiProvider) e o
 * `window.api` (bridgeApi.ts); qualquer falha vira aviso com "Voltar"
 * (OfficeBoundary), nunca a tela preta.
 */
import { useEffect, useMemo, useState } from 'react'
import { Office3DWorkspace } from '@renderer/office3d/Office3DWorkspace'
import { client, openConversation } from '../app/runtime'
import { CENTRAL_CONV_ID } from '../core/client'
import { useStore } from '../core/store'
import { ReconnectBar } from '../chat/ChatBars'
import { BACK, useBackHandler } from '../shell/backButton'
import { StatusPill } from '../shell/StatusMenu'
import { Icon } from '../ui/icons'
import { installBridgeApi } from './bridgeApi'
import { OfficeBoundary } from './OfficeBoundary'
import { PhoneOfficeFeed } from './phoneFeed'
import { PhoneUiProvider } from './PhoneUiProvider'
import '../styles/office.css'

/**
 * Um Esc sintético, como a tecla no PC (alvo no body: as capturas da janela — menu,
 * cartão — vêm antes do motor). Consumido = alguém deu preventDefault ou parou a
 * propagação antes de chegar ao fim (o nosso ouvinte, o último da janela).
 */
export function escapeOffice(): boolean {
  let reached = false
  const mark = (): void => {
    reached = true
  }
  window.addEventListener('keydown', mark)
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  try {
    document.body.dispatchEvent(ev)
  } finally {
    window.removeEventListener('keydown', mark)
  }
  return ev.defaultPrevented || !reached
}

export function OfficeTab({ active }: { active: boolean }): JSX.Element {
  const feed = useMemo(() => {
    installBridgeApi(client)
    return new PhoneOfficeFeed(client)
  }, [])
  useEffect(() => () => feed.dispose(), [feed])
  const engineOptions = useMemo(() => ({ source: feed, browser: null, board: null }), [feed])
  // A conversa escolhida no 3D (toque no agente): a faixa de baixo abre o chat dela.
  const [picked, setPicked] = useState<string | null>(null)
  const conv = useStore(client.store, (s) => s.conversations.find((c) => c.id === picked) ?? null)
  // Voltar: primeiro o que está aberto no 3D (o mesmo Esc do PC — menu do monitor, cartão do
  // kanban e, por fim, a tela focada com engine.leaveFocus, como o ×); depois a faixa do agente.
  useBackHandler(
    BACK.focus,
    () => {
      if (escapeOffice()) return
      if (!picked) return false
      setPicked(null)
    },
    active
  )

  return (
    <div className="tab-view office-tab" hidden={!active}>
      <header className="topbar">
        <div className="topbar-title"><span className="t">Escritório</span></div>
        <StatusPill />
      </header>
      <ReconnectBar />
      <div className="office-host">
        <PhoneUiProvider>
          <OfficeBoundary>
            <Office3DWorkspace
              active={active}
              chat={null}
              onOpenConversation={(id) => setPicked(id === CENTRAL_CONV_ID ? null : id)}
              onFocusRequest={(id) => openConversation(id)}
              engineOptions={engineOptions}
            />
          </OfficeBoundary>
        </PhoneUiProvider>
        {conv ? (
          <div className="office-pick">
            <button type="button" className="office-pick-open" onClick={() => openConversation(conv.id)}>
              <Icon name="chat" size={18} />
              <span className="office-pick-title">{conv.title || 'Conversa'}</span>
              {conv.busy ? <span className="office-pick-busy">trabalhando</span> : null}
            </button>
            <button type="button" className="office-pick-close" aria-label="Fechar" onClick={() => setPicked(null)}>
              ×
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
