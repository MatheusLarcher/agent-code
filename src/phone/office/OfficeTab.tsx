/**
 * A aba Escritório do celular: o MESMO escritório 3D do PC (Office3DWorkspace +
 * motor), com o feed montado da ponte (phoneFeed.ts) e os modelos/animações
 * baixados do PC (`/api/office-agent`). Fica montada depois da 1ª abertura e
 * pausa fora da aba (o motor para o laço), como a aba do PC.
 *
 * Toque: arrastar move, dois dedos dão zoom e giram, toque no agente abre o
 * monitor dele; a faixa de baixo leva ao chat da conversa escolhida.
 */
import { useEffect, useMemo, useState } from 'react'
import { Office3DWorkspace } from '@renderer/office3d/Office3DWorkspace'
import { client, openConversation } from '../app/runtime'
import { CENTRAL_CONV_ID } from '../core/client'
import { useStore } from '../core/store'
import { ReconnectBar } from '../chat/ChatBars'
import { StatusPill } from '../shell/StatusMenu'
import { Icon } from '../ui/icons'
import { PhoneOfficeFeed } from './phoneFeed'
import '../styles/office.css'

type AgentFileApi = { officeAgentFile?: (name: string) => Promise<Uint8Array | null> }

/** O carregador dos modelos do motor (agentModels.ts) lê `window.api.officeAgentFile`: no celular, vem da ponte. */
function installAgentFiles(): void {
  const w = window as unknown as { api?: AgentFileApi }
  if (w.api?.officeAgentFile) return
  w.api = {
    ...(w.api ?? {}),
    officeAgentFile: async (name) => {
      try {
        const res = await fetch(client.url(`/api/office-agent?name=${encodeURIComponent(name)}`))
        return res.ok ? new Uint8Array(await res.arrayBuffer()) : null
      } catch {
        return null
      }
    }
  }
}

export function OfficeTab({ active }: { active: boolean }): JSX.Element {
  const feed = useMemo(() => {
    installAgentFiles()
    return new PhoneOfficeFeed(client)
  }, [])
  useEffect(() => () => feed.dispose(), [feed])
  const engineOptions = useMemo(() => ({ source: feed, browser: null, board: null }), [feed])
  // A conversa escolhida no 3D (toque no agente): a faixa de baixo abre o chat dela.
  const [picked, setPicked] = useState<string | null>(null)
  const conv = useStore(client.store, (s) => s.conversations.find((c) => c.id === picked) ?? null)

  return (
    <div className="tab-view office-tab" hidden={!active}>
      <header className="topbar">
        <div className="topbar-title"><span className="t">Escritório</span></div>
        <StatusPill />
      </header>
      <ReconnectBar />
      <div className="office-host">
        <Office3DWorkspace
          active={active}
          chat={null}
          onOpenConversation={(id) => setPicked(id === CENTRAL_CONV_ID ? null : id)}
          onFocusRequest={(id) => openConversation(id)}
          engineOptions={engineOptions}
        />
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
