/** Uma conversa aberta na aba Conversas: cabeçalho, faixas, mensagens, plano, composer e o pedido pendente. */
import { useState } from 'react'
import { backToList, client } from '../app/runtime'
import { useStore } from '../core/store'
import { Composer, type ComposerDraft } from '../composer/Composer'
import { StatusPill } from '../shell/StatusMenu'
import { Icon } from '../ui/icons'
import { ProjectLogo, projectLabel } from '../ui/ProjectLogo'
import { BackgroundTasksCard, SubagentStrip } from './AgentBars'
import { ReconnectBar, TodoPlan, TurnRecovery } from './ChatBars'
import { MessageList } from './MessageList'
import { PermissionModal } from './PermissionModal'
import { PromptSuggestionChip } from './PromptSuggestion'

export function ChatView(): JSX.Element {
  const conv = useStore(client.store, (s) => s.conversations.find((c) => c.id === s.convId) ?? null)
  const convId = useStore(client.store, (s) => s.convId)
  // O texto que o chip da sugestão põe no campo (a cada nonce novo, sem enviar).
  const [draft, setDraft] = useState<ComposerDraft | null>(null)
  const refresh = (): Promise<unknown> => (convId ? client.loadHistory(convId, true) : Promise.resolve())
  return (
    <div className="tab-view chat-view">
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="Voltar às conversas" onClick={backToList}>
          <Icon name="back" size={22} />
        </button>
        <button type="button" className="topbar-title" title="Trocar conversa" onClick={backToList}>
          {conv?.cwd && <ProjectLogo cwd={conv.cwd} size={26} />}
          <span className="topbar-stack">
            <span className="t">{conv?.title || 'Conversa'}</span>
            {conv?.cwd && <span className="topbar-sub">{projectLabel(conv.cwd)}</span>}
          </span>
        </button>
        <StatusPill />
      </header>
      <ReconnectBar />
      {conv && <TurnRecovery conv={conv} />}
      <MessageList onRefresh={refresh} />
      {conv && <TodoPlan conv={conv} />}
      {conv && <SubagentStrip conv={conv} />}
      {conv && <BackgroundTasksCard conv={conv} />}
      {conv && <PromptSuggestionChip conv={conv} onUse={(text) => setDraft((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }))} />}
      <Composer draft={draft} />
      <PermissionModal />
    </div>
  )
}
