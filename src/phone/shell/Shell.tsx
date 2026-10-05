/**
 * O app conectado: a aba ativa e a barra de abas embaixo (Central · Conversas ·
 * Quadro), ao alcance do polegar. A barra respeita a área segura inferior e some
 * com o teclado aberto. O Escritório entra na fase 2.
 */
import { client, nav, openTab, type Tab } from '../app/runtime'
import { CENTRAL_CONV_ID } from '../core/client'
import { useStore } from '../core/store'
import { CentralView } from '../central/CentralView'
import { ChatView } from '../chat/ChatView'
import { ConversationList } from '../conversations/ConversationList'
import { Settings } from '../settings/Settings'
import { Icon, type IconName } from '../ui/icons'
import { QuadroPlaceholder } from './QuadroPlaceholder'
import { StatusMenu } from './StatusMenu'
import { viewport } from './useViewport'

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'central', label: 'Central', icon: 'spark' },
  { id: 'conversas', label: 'Conversas', icon: 'chat' },
  { id: 'quadro', label: 'Quadro', icon: 'board' }
]

function TabBar(): JSX.Element | null {
  const tab = useStore(nav, (s) => s.tab)
  const keyboard = useStore(viewport, (s) => s.keyboard)
  // Pedido esperando resposta numa conversa: um ponto na aba Conversas.
  const waiting = useStore(client.store, (s) => s.conversations.some((c) => c.id !== CENTRAL_CONV_ID && !!c.permission))
  const centralAsks = useStore(client.store, (s) => {
    const central = s.conversations.find((c) => c.id === CENTRAL_CONV_ID)?.central
    return (central?.questions?.length ?? 0) > 0 || !!central?.entries?.some((e) => e?.kind === 'request' && e.state === 'asking' && !e.foreign)
  })
  if (keyboard) return null
  return (
    <nav className="tabbar" aria-label="Abas">
      {TABS.map((t) => (
        <button key={t.id} type="button" className={`tab${tab === t.id ? ' active' : ''}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => openTab(t.id)}>
          <span className="tab-ico">
            <Icon name={t.icon} size={22} />
            {((t.id === 'conversas' && waiting) || (t.id === 'central' && centralAsks)) && <span className="tab-dot" />}
          </span>
          <span className="tab-label">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}

export function Shell(): JSX.Element {
  const tab = useStore(nav, (s) => s.tab)
  const chatOpen = useStore(nav, (s) => s.chatOpen)
  const convId = useStore(client.store, (s) => s.convId)
  const showChat = tab === 'conversas' && chatOpen && !!convId && convId !== CENTRAL_CONV_ID
  return (
    <>
      <div className="tab-host">
        {tab === 'central' ? <CentralView /> : tab === 'quadro' ? <QuadroPlaceholder /> : showChat ? <ChatView /> : <ConversationList />}
      </div>
      <TabBar />
      <StatusMenu />
      <Settings />
    </>
  )
}
