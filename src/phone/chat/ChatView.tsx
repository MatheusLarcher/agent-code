/** Uma conversa aberta na aba Conversas: cabeçalho, faixas, mensagens, plano, composer e o pedido pendente. */
import { backToList, client } from '../app/runtime'
import { useStore } from '../core/store'
import { Composer } from '../composer/Composer'
import { StatusPill } from '../shell/StatusMenu'
import { Icon } from '../ui/icons'
import { BusyBar, ReconnectBar, TodoPlan, TurnRecovery } from './ChatBars'
import { MessageList } from './MessageList'
import { PermissionModal } from './PermissionModal'

export function ChatView(): JSX.Element {
  const conv = useStore(client.store, (s) => s.conversations.find((c) => c.id === s.convId) ?? null)
  const convId = useStore(client.store, (s) => s.convId)
  const refresh = (): Promise<unknown> => (convId ? client.loadHistory(convId, true) : Promise.resolve())
  return (
    <div className="tab-view chat-view">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="Voltar às conversas" onClick={backToList}>
          <Icon name="back" size={22} />
        </button>
        <button type="button" className="topbar-title" title="Trocar conversa" onClick={backToList}>
          <span className="t">{conv?.title || 'Conversa'}</span>
        </button>
        <StatusPill />
      </header>
      <ReconnectBar />
      {conv && <TurnRecovery conv={conv} />}
      <MessageList onRefresh={refresh} />
      {conv && <BusyBar conv={conv} />}
      {conv && <TodoPlan conv={conv} />}
      <Composer />
      <PermissionModal />
    </div>
  )
}
