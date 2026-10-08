/**
 * MCP de entrada, lado da tela: a tarefa chega do main (`mcp:inbound`) e entra
 * na conversa pelo MESMO `dispatch` do composer e do celular — fila de espera,
 * bolha, sessão. A conversa nova nasce SEM virar a ativa: o usuário pode estar
 * usando o app, e a tarefa roda ao fundo.
 *
 * O status mora no main (que o tira do `agent:send` e do fim do turno). Daqui só
 * sai o que o main não teria como saber: a tarefa não chegou à conversa, ou um
 * item dela saiu da fila sem rodar (Stop, lixeira, conversa apagada).
 */
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ImageAttachment, McpInboundMsg } from '@shared/ipc'
import { CENTRAL_ID, isCentralConversation } from '@shared/central'
import { MCP_TASK_MODEL } from '@shared/mcpInbound'
import { imageSrc } from './inlineMedia/inlineAttachments'
import type { Conversation } from './types'
import { loadConversationsByIds } from './storage'

/** O mínimo de um item da fila que este hook lê e marca. */
export interface McpQueueItem {
  id: string
  convId: string
  full: string
  /** A tarefa MCP deste item (só os que vieram do MCP de entrada). */
  mcpTaskId?: string
}

export interface McpInboundDeps<Q extends McpQueueItem> {
  /** As conversas já carregaram: o main pode começar a entregar. */
  hydrated: boolean
  convsRef: MutableRefObject<Conversation[]>
  queueRef: MutableRefObject<Q[]>
  setQueue: Dispatch<SetStateAction<Q[]>>
  /** Cria a conversa com esse id e esses campos, sem ativá-la. */
  createBackground: (cwd: string, id: string, extra: Partial<Conversation>) => Conversation
  /** Põe na tela uma conversa lida do banco (ainda não carregada). */
  addLoaded: (conv: Conversation) => void
  /** O dispatch do composer; `images` já rotuladas (`midia:N = nome`) e `thumbs` as
   *  miniaturas da bolha. `taskId` anda com a mensagem (fila, envio, reenvio): é
   *  por ele que o main sabe que ela é aquela tarefa. */
  dispatch: (
    conv: Conversation,
    full: string,
    text: string,
    images: ImageAttachment[],
    thumbs: string[],
    taskId: string
  ) => Promise<void>
  isBusy: (convId: string) => boolean
}

/** Os campos de uma conversa nova de tarefa MCP: título travado (a 1ª linha do
 *  prompt não é o nome — o nome vem do cliente) e o modelo da tarefa (o padrão
 *  das tarefas MCP quando o chamador não escolheu). Quem manda na sessão é o
 *  main; aqui é só o que o seletor mostra. */
export function mcpConversationFields(title: string, model: string = MCP_TASK_MODEL): Partial<Conversation> {
  return { title, titleSource: 'user', model, fastMode: false }
}

/** Avisa o main de cada tarefa MCP entre `items` que saiu da fila sem rodar. */
export function reportMcpDropped(items: readonly McpQueueItem[], reason: string): void {
  for (const it of items) {
    if (it.mcpTaskId) void window.api.mcpTaskFailed?.(it.mcpTaskId, reason, true).catch(() => undefined)
  }
}

/** O item saiu da fila mas o envio falhou (ex.: a troca de modelo da tarefa): a
 *  tarefa MCP dele vira erro com esta mensagem. O main ignora se ela já terminou. */
export function reportMcpFailed(item: McpQueueItem, erro: string): void {
  if (item.mcpTaskId) fail(item.mcpTaskId, erro)
}

function fail(taskId: string, erro: string): void {
  void window.api.mcpTaskFailed?.(taskId, erro).catch(() => undefined)
}

/** A Central só encaminha (ver central/): tarefa MCP nunca entra nela. */
export const CENTRAL_REFUSES_TASKS = 'A Central não recebe tarefas diretamente.'

async function findConversation<Q extends McpQueueItem>(
  d: McpInboundDeps<Q>,
  msg: McpInboundMsg
): Promise<Conversation | null> {
  const known = d.convsRef.current.find((c) => c.id === msg.convId)
  if (known) return known
  if (msg.create) {
    const conv = d.createBackground(msg.create.cwd, msg.convId, mcpConversationFields(msg.create.title, msg.model))
    // O estado só chega a convsRef no próximo render; o dispatch logo abaixo
    // precisa achá-la já (mesmo cuidado do startHandoff).
    if (!d.convsRef.current.some((c) => c.id === conv.id)) d.convsRef.current = [conv, ...d.convsRef.current]
    return conv
  }
  // conversa_id de uma conversa que existe no banco, mas não foi carregada.
  const [loaded] = await loadConversationsByIds([msg.convId]).catch(() => [] as Conversation[])
  if (!loaded) return null
  if (!d.convsRef.current.some((c) => c.id === loaded.id)) {
    d.addLoaded(loaded)
    d.convsRef.current = [loaded, ...d.convsRef.current]
  }
  return d.convsRef.current.find((c) => c.id === loaded.id) ?? loaded
}

/** Entrega uma tarefa: acha/cria a conversa, despacha, marca o item da fila. */
export async function handleMcpInbound<Q extends McpQueueItem>(d: McpInboundDeps<Q>, msg: McpInboundMsg): Promise<void> {
  // Antes de procurar: com `create`, o id fixo da Central viraria uma conversa de tarefa.
  if (msg.convId === CENTRAL_ID) return fail(msg.taskId, CENTRAL_REFUSES_TASKS)
  const conv = await findConversation(d, msg)
  if (!conv) return fail(msg.taskId, 'A conversa não foi encontrada no Agent Code.')
  if (isCentralConversation(conv)) return fail(msg.taskId, CENTRAL_REFUSES_TASKS)
  // Imagens do chamador: já validadas e rotuladas no main — o texto leva
  // `{{midia:N}}` e a bolha as mostra no lugar, como uma imagem colada.
  const images = msg.images ?? []
  // O id da tarefa vai com a mensagem: o item da fila nasce marcado (para
  // cancelar só ele, e para o main reconhecer a tarefa pelo id, nunca pelo texto).
  await d.dispatch(conv, msg.text, msg.text, images, images.map(imageSrc), msg.taskId)
  const queued = d.queueRef.current.some((m) => m.convId === conv.id && m.mcpTaskId === msg.taskId)
  if (!queued && !d.isBusy(conv.id)) {
    // Nem na fila nem rodando: o envio falhou antes de chegar ao agente.
    fail(msg.taskId, 'Não consegui enviar a tarefa ao agente (veja a conversa no Agent Code).')
  }
}

export function useMcpInbound<Q extends McpQueueItem>(deps: McpInboundDeps<Q>): void {
  // Os ouvintes assinam uma vez; as dependências (recriadas a cada render) vêm pela ref.
  const depsRef = useRef(deps)
  depsRef.current = deps

  useEffect(() => window.api.onMcpInbound?.((msg) => void handleMcpInbound(depsRef.current, msg)), [])

  useEffect(
    () =>
      window.api.onMcpCancelQueued?.(({ convId, taskId }) => {
        const d = depsRef.current
        const keep = (m: Q): boolean => !(m.convId === convId && m.mcpTaskId === taskId)
        d.queueRef.current = d.queueRef.current.filter(keep)
        d.setQueue((q) => q.filter(keep))
      }),
    []
  )

  // Ouvinte montado e conversas carregadas: o main entrega o que esperava.
  useEffect(() => {
    if (deps.hydrated) void window.api.mcpRendererReady?.().catch(() => undefined)
  }, [deps.hydrated])
}
