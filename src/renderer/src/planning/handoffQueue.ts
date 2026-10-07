import { useEffect, useRef, useState } from 'react'
import type { AgentCodeApi } from '@shared/api'
import type { Conversation } from '../types'

/**
 * O DESPACHANTE da fila do quadro no renderer. A decisão mora no main
 * (handoff:queueGate, regra fixa: anterior concluído → o próximo sai); aqui só
 * se pergunta e despacha, pelo MESMO `dispatch` do App (bolha, retomada,
 * Automático, Central) — nunca pelo envio direto do main.
 *
 * Quem chama `check`: toda conversa de implantação que fica OCIOSA (o fim do
 * turno, o erro esgotado, o Stop, a retomada dos subagentes e a fila mantida
 * passam todos pelo `setBusy(false)`), o `handoff:changed` (o envio anterior
 * concluiu depois: veredito atrasado do PO, cartão arrastado, commit pego pelo
 * vigia) e a abertura do app (envios que esperavam no banco).
 *
 * O que o usuário digita tem prioridade: com a fila do chat cheia ou um turno
 * rodando, a conversa não está ociosa e nada sai daqui.
 */

export interface HandoffQueueDeps {
  api: Pick<AgentCodeApi, 'handoffQueueGate' | 'handoffQueueDispatched'>
  conversation(id: string): Conversation | undefined
  /** Ociosa de verdade: sem turno, fila do chat vazia, sem subagente, sem Stop, sem retomada pendente. */
  idle(id: string): boolean
  /** Espera o main encerrar o turno anterior de fato (ocioso + lease solto). */
  waitTurnEnd(id: string): Promise<unknown>
  dispatch(conv: Conversation, text: string): Promise<void>
  /** A fila parou: o motivo (a faixa "Próximos prompts" mostra). */
  onHold?(convId: string, motivo: string): void
  /** Conversa sem plano que também tem fila: a do PO autorizado "sempre" (a rotina de commit). */
  queueCapable?(convId: string): boolean
}

export interface HandoffQueueDispatcher {
  /** Confere a fila do quadro da conversa e, com o anterior concluído, manda o próximo. */
  check(convId: string): Promise<void>
  /** "Enviar mesmo assim": manda o próximo com o anterior não concluído (ação do usuário). */
  sendAnyway(convId: string): Promise<boolean>
}

const isImplementation = (conv: Conversation | undefined): conv is Conversation => Boolean(conv?.handoffSlug)

export function createHandoffQueueDispatcher(deps: HandoffQueueDeps): HandoffQueueDispatcher {
  // Uma conferência por conversa; pedidos no meio viram UMA repetição no fim.
  const running = new Map<string, Promise<boolean>>()
  const again = new Set<string>()

  const hasQueue = (convId: string, conv: Conversation | undefined): conv is Conversation =>
    isImplementation(conv) || (!!conv && deps.queueCapable?.(convId) === true)

  async function run(convId: string, force: boolean): Promise<boolean> {
    if (!hasQueue(convId, deps.conversation(convId))) return false
    if (!force && !deps.idle(convId)) return false
    if (!force) await deps.waitTurnEnd(convId)
    const res = await deps.api.handoffQueueGate({ conversationId: convId, ...(force ? { force: true } : {}) })
    if (!res?.ok) return false
    const decision = res.decision
    if (decision.kind === 'hold') deps.onHold?.(convId, decision.motivo)
    if (decision.kind !== 'next') return false
    // A espera pelo main pode ter durado: o usuário pode ter mandado algo nesse meio-tempo.
    const conv = deps.conversation(convId)
    if (!hasQueue(convId, conv) || (!force && !deps.idle(convId))) return false
    const marked = await deps.api.handoffQueueDispatched({ conversationId: convId, envioId: decision.envio.id })
    // `dispatched: false`: outra conferência mandou antes.
    if (!marked?.ok || !marked.dispatched) return false
    await deps.dispatch(conv, decision.envio.conteudo)
    return true
  }

  function schedule(convId: string, force: boolean): Promise<boolean> {
    const current = running.get(convId)
    if (current && !force) {
      again.add(convId)
      return current
    }
    const work = (current ?? Promise.resolve(false))
      .then(() => run(convId, force))
      .catch(() => false)
      .finally(() => {
        if (running.get(convId) === work) running.delete(convId)
        if (again.delete(convId)) void schedule(convId, false)
      })
    running.set(convId, work)
    return work
  }

  return {
    check: async (convId) => void (await schedule(convId, false)),
    sendAnyway: (convId) => schedule(convId, true)
  }
}

/**
 * O despachante ligado ao App: `handoff:changed` confere a conversa, e a
 * abertura (`hydrated`) confere toda conversa com prompt esperando no banco.
 * As dependências chegam por ref (o App as recria a cada render).
 */
export function useHandoffQueue(
  hydrated: boolean,
  deps: HandoffQueueDeps & { api: HandoffQueueDeps['api'] & Pick<AgentCodeApi, 'handoffQueueList' | 'onHandoffChanged'> }
): HandoffQueueDispatcher {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const [dispatcher] = useState(() =>
    createHandoffQueueDispatcher({
      api: {
        handoffQueueGate: (req) => depsRef.current.api.handoffQueueGate(req),
        handoffQueueDispatched: (req) => depsRef.current.api.handoffQueueDispatched(req)
      },
      conversation: (id) => depsRef.current.conversation(id),
      idle: (id) => depsRef.current.idle(id),
      waitTurnEnd: (id) => depsRef.current.waitTurnEnd(id),
      dispatch: (conv, text) => depsRef.current.dispatch(conv, text),
      onHold: (id, motivo) => depsRef.current.onHold?.(id, motivo),
      queueCapable: (id) => depsRef.current.queueCapable?.(id) === true
    })
  )

  useEffect(() => depsRef.current.api.onHandoffChanged?.(({ conversationId }) => void dispatcher.check(conversationId)), [dispatcher])

  useEffect(() => {
    if (!hydrated) return
    let alive = true
    void Promise.resolve(depsRef.current.api.handoffQueueList?.())
      .then((res) => {
        if (!alive || !res?.ok) return
        for (const convId of new Set(res.items.map((item) => item.conversationId))) void dispatcher.check(convId)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [hydrated, dispatcher])

  return dispatcher
}
