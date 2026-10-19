/**
 * "Chat" do plano aberto: a conversa do Agent Manager dele (a de `mode:
 * 'planning'` com o mesmo projeto e slug), com o chat resumido do celular
 * (MessageList com os [[Nome]] de card na cor do tipo), as faixas, o Composer e o
 * pedido pendente de sempre. "Comentar no chat" chega aqui com `[[Título]] ` no campo.
 * Acima do Composer, os dois botões da Tela de Planejamento do PC: "Iniciar
 * questionário" (o mesmo texto, pelo envio normal — fila se ocupado; as perguntas
 * chegam no PermissionModal) e "Enviar para implementação" (a folha HandoffSheet).
 */
import { useEffect, useMemo, useState } from 'react'
import { managerQuestionnaireRequest } from '@shared/managerRequests'
import { makeRefResolver } from '@renderer/planning/cardRefs'
import { client, toast } from '../app/runtime'
import { errorText } from '../core/net'
import { useStore } from '../core/store'
import { TodoPlan, TurnRecovery } from '../chat/ChatBars'
import { MessageList } from '../chat/MessageList'
import { PermissionModal } from '../chat/PermissionModal'
import { Composer } from '../composer/Composer'
import { Icon } from '../ui/icons'
import { clearDraft, managerConv, openHandoff, planUi } from './planState'

/** "Iniciar questionário" e "Enviar para implementação". */
function PlanChatActions(): JSX.Element {
  const [asking, setAsking] = useState(false)
  const questionnaire = (): void => {
    if (asking) return
    setAsking(true)
    client
      .send({ text: managerQuestionnaireRequest(), images: [], files: [] })
      .then(() => toast('Questionário pedido ao Agent Manager: as perguntas aparecem aqui.', 'sucesso'))
      .catch((err) => toast(`Não consegui pedir o questionário: ${errorText(err)}`, 'erro'))
      .finally(() => setAsking(false))
  }
  return (
    <div className="pl-chat-actions">
      <button type="button" className="pl-chat-btn" disabled={asking} onClick={questionnaire}>
        {asking ? <span className="spinner" /> : <Icon name="help" size={16} />} Iniciar questionário
      </button>
      <button type="button" className="pl-chat-btn primary" onClick={openHandoff}>
        <Icon name="rocket" size={16} /> Enviar para implementação
      </button>
    </div>
  )
}

export function PlanChat(): JSX.Element {
  const open = useStore(planUi, (s) => s.open)
  const plan = useStore(planUi, (s) => s.plan)
  const draft = useStore(planUi, (s) => s.draft)
  const conv = useStore(client.store, (s) => managerConv(s.conversations, open))
  const convId = useStore(client.store, (s) => s.convId)
  const resolveRef = useMemo(() => (plan?.cards.length ? makeRefResolver(plan.cards) : null), [plan])
  const id = conv?.id ?? null
  const ready = !!id && convId === id

  // A conversa do Manager vira a "aberta" do cliente: histórico, SSE e envio vão para ela.
  useEffect(() => {
    if (id && client.state.convId !== id) client.selectConv(id)
  }, [id])

  // O Composer (filho: o efeito dele roda antes) já pôs o texto no campo; não repete ao remontar.
  useEffect(() => {
    if (ready && draft) clearDraft()
  }, [ready, draft])

  if (!conv) {
    return (
      <div className="empty-state">
        <strong>Sem conversa do Agent Manager</strong>
        A conversa deste plano não está aberta no PC. Abra o plano no PC para retomar a conversa com o Manager.
      </div>
    )
  }
  const refresh = (): Promise<unknown> => client.loadHistory(conv.id, true)
  return (
    <div className="pl-chat chat-view">
      <TurnRecovery conv={conv} />
      {ready ? <MessageList onRefresh={refresh} resolveRef={resolveRef} /> : <div className="messages-loading"><span className="spinner" /> Abrindo a conversa…</div>}
      <TodoPlan conv={conv} />
      {ready && <PlanChatActions />}
      {ready && <Composer draft={draft} />}
      {ready && <PermissionModal />}
    </div>
  )
}
