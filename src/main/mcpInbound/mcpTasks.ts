/**
 * As tarefas do MCP de entrada, só em memória (as conversas é que persistem):
 * reiniciado o app, um `tarefa_id` antigo não existe mais.
 *
 * O status acompanha a conversa pelo mesmo tee que alimenta a tela:
 * - `na_fila`: entregue ao renderer, ainda não saiu (a conversa estava ocupada);
 * - `rodando`: o `agent:send` desta conversa levou o ID da tarefa (o item da
 *   fila da tela sabe de qual tarefa é). Casamento só pelo id: envio sem id é
 *   mensagem do usuário, mesmo com o texto igual ao de uma tarefa;
 * - `pergunta`: o agente chamou AskUserQuestion; a pergunta volta ao chamador;
 * - `concluida` / `erro` / `cancelada`: finais. Tarefa final nunca volta a rodar:
 *   quem repete é o chamador, com uma tarefa nova. Qualquer erro no turno dela
 *   (inclusive os que o app repetiria numa mensagem do usuário: 529, limite de
 *   uso) a encerra como `erro`.
 */
import { randomUUID } from 'node:crypto'
import type { AskQuestion, ChatEvent, PermissionRequest } from '../../shared/ipc'

export type McpTaskStatus = 'na_fila' | 'rodando' | 'pergunta' | 'concluida' | 'erro' | 'cancelada'

/** Servidor MCP stdio trazido pelo chamador, só para as tarefas da conversa dele. */
export interface McpStdioServer {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface McpConversationConfig {
  cliente: string
  mcpServers: Record<string, McpStdioServer>
}

export interface McpQuestion {
  id: string
  perguntas: AskQuestion[]
  /** Epoch ms em que a pergunta expira sem resposta (o agente segue sem ela). */
  prazo?: number
}

export interface McpTask {
  id: string
  convId: string
  text: string
  status: McpTaskStatus
  resposta?: string
  erro?: string
  pergunta?: McpQuestion
  /** Modelo pedido pelo chamador para ESTA tarefa; ausente = o padrão das tarefas MCP. */
  model?: string
  createdAt: number
  updatedAt: number
}

/** O que o cancelamento precisa fazer do lado da conversa. */
export type McpCancelAction = 'none' | 'drop-queued' | 'interrupt'

const FINAL: ReadonlySet<McpTaskStatus> = new Set(['concluida', 'erro', 'cancelada'])
/** Turno de tarefa ainda aberto quando a conversa seguiu com outra mensagem. */
export const SUPERSEDED = 'A conversa seguiu com outra mensagem antes de a tarefa terminar.'
/** Teto de tarefas guardadas: as finais mais velhas saem primeiro. */
const MAX_TASKS = 500
/** Ids de turnos encerrados guardados por conversa: só os recentes têm rabo atrasado. */
const MAX_ENDED_IDS = 64

export class McpTaskRegistry {
  private readonly tasks = new Map<string, McpTask>()
  /** Por conversa: as tarefas `na_fila`, na ordem em que vão sair. */
  private readonly pending = new Map<string, string[]>()
  /** Por conversa: as tarefas do turno em andamento — a que abriu o turno e as
   *  que entraram nele pelo botão "agora" (injectNow). O fim do turno vale para todas. */
  private readonly current = new Map<string, string[]>()
  /** Por conversa: o último turno que o `agent:send` abriu era de tarefa MCP? */
  private readonly lastTurnTask = new Map<string, boolean>()
  private readonly configs = new Map<string, McpConversationConfig>()
  /** Por conversa: o `messageUuid` do envio que abriu o turno em andamento. */
  private readonly turnUuid = new Map<string, string>()
  /** Por conversa: os `turnIds` de turnos que já acabaram. O 2º terminal atrasado
   *  de um deles (fim do stream depois do `result`) não encerra o turno seguinte. */
  private readonly endedIds = new Map<string, string[]>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => `t-${randomUUID()}`
  ) {}

  /** A config (servidores do chamador, cliente) vale para a conversa até o app fechar. */
  setConfig(convId: string, config: McpConversationConfig): void {
    this.configs.set(convId, config)
  }

  configFor(convId: string): McpConversationConfig | undefined {
    return this.configs.get(convId)
  }

  create(convId: string, text: string, model?: string): McpTask {
    const at = this.now()
    const task: McpTask = { id: this.newId(), convId, text, status: 'na_fila', createdAt: at, updatedAt: at, ...(model ? { model } : {}) }
    this.tasks.set(task.id, task)
    this.pending.set(convId, [...(this.pending.get(convId) ?? []), task.id])
    this.evict()
    return task
  }

  get(id: string): McpTask | undefined {
    return this.tasks.get(id)
  }

  /**
   * A tarefa VIVA que o envio com este `taskId` leva: a da fila (vai começar) ou
   * a do turno aberto desta conversa (o mesmo item reenviado, ex.: devolvido à
   * fila pelo reparo do espelho). Id de outra conversa, de tarefa já terminada
   * ou desconhecido (app reiniciado): nenhuma — e o envio é RECUSADO (regra 1,
   * `McpInbound.refusal`), nunca vira mensagem do usuário. Sem id: mensagem do
   * usuário, mesmo com o texto igual ao de uma tarefa.
   */
  taskFor(convId: string, taskId: string | undefined): McpTask | undefined {
    const task = taskId ? this.tasks.get(taskId) : undefined
    if (!task || task.convId !== convId || FINAL.has(task.status)) return undefined
    if (task.status === 'na_fila') return task
    return this.current.get(convId)?.includes(task.id) ? task : undefined
  }

  /** O último turno aberto pelo `agent:send` nesta conversa era de tarefa MCP? */
  lastTurnWasTask(convId: string): boolean {
    return this.lastTurnTask.get(convId) === true
  }

  /**
   * `agent:send` da conversa. `recovery` (retomada automática de mensagem do
   * usuário) não mexe em tarefa: nunca continua uma. O reenvio do item da
   * tarefa aberta (mesmo id) continua o turno dela. Qualquer outro envio com um
   * turno de tarefa ainda aberto o encerra como erro — a mensagem nova não é
   * continuação dele nem o fecha com a resposta dela. Se o id é o de uma tarefa
   * da fila, ela começou.
   */
  noteSend(convId: string, taskId: string | undefined, kind: 'normal' | 'recovery' = 'normal', messageUuid?: string): void {
    if (kind === 'recovery') return
    const task = this.taskFor(convId, taskId)
    if (task && task.status !== 'na_fila') {
      // O mesmo item reenviado continua o turno — agora com o id deste envio.
      if (messageUuid) this.turnUuid.set(convId, messageUuid)
      return
    }
    if (this.primary(convId)) this.endTurn(convId, 'erro', { erro: SUPERSEDED })
    if (messageUuid) this.turnUuid.set(convId, messageUuid)
    else this.turnUuid.delete(convId)
    this.lastTurnTask.set(convId, !!task)
    if (!task) return
    this.removePending(task)
    this.current.set(convId, [task.id])
    this.update(task, { status: 'rodando' })
  }

  /** A tarefa da fila com este id — o que o "agora" do item levaria. */
  queuedTask(convId: string, taskId: string | undefined): McpTask | undefined {
    const task = this.taskFor(convId, taskId)
    return task?.status === 'na_fila' ? task : undefined
  }

  /** Botão "agora": a tarefa da fila entrou no turno em andamento. O turno passa
   *  a ser de tarefa (mesmo aberto por uma mensagem do usuário): a retomada
   *  automática dele é recusada (regra 2) — ela repetiria o conteúdo da tarefa. */
  noteInjected(convId: string, taskId: string | undefined): McpTask | undefined {
    const task = this.queuedTask(convId, taskId)
    if (!task) return undefined
    this.removePending(task)
    this.lastTurnTask.set(convId, true)
    this.current.set(convId, [...(this.current.get(convId) ?? []), task.id])
    this.update(task, { status: 'rodando' })
    return task
  }

  /** Fim de turno da conversa (o mesmo tee da tela). Regra 2: QUALQUER erro
   *  encerra a tarefa do turno — retryable ou não (529, limite de uso). O app
   *  não repete turno de tarefa; o chamador vê o erro e decide reenviar. */
  observe(convId: string, event: ChatEvent): void {
    if (event.kind !== 'result' && event.kind !== 'error') return
    // Terminal de um turno que já acabou (todos os ids dele são de turnos
    // encerrados): não é deste turno — nem o conclui, nem o derruba.
    if (this.isLateTail(convId, event.turnIds)) return
    if (event.turnIds?.length) this.markEnded(convId, event.turnIds)
    if (event.kind === 'result') {
      if (event.isError) this.endTurn(convId, 'erro', { erro: shortError(event.text) })
      else this.endTurn(convId, 'concluida', { resposta: event.text ?? '' })
    } else if (event.kind === 'error') {
      this.endTurn(convId, 'erro', { erro: shortError(event.text) })
    }
  }

  /** O agente perguntou (AskUserQuestion): a pergunta vai para o chamador. */
  onQuestion(convId: string, req: PermissionRequest): void {
    if (!req.questions?.length) return
    const task = this.primary(convId)
    if (!task) return
    this.update(task, { status: 'pergunta', pergunta: { id: req.id, perguntas: req.questions, prazo: req.deadline } })
  }

  /** Respondida (pelo chamador ou no app) ou expirada: a tarefa volta a rodar. */
  onQuestionClosed(convId: string, requestId: string): void {
    const task = this.primary(convId)
    if (!task || task.pergunta?.id !== requestId) return
    this.update(task, { status: 'rodando', pergunta: undefined })
  }

  /** Diz o que a conversa precisa fazer; a da fila já sai cancelada aqui. */
  cancel(id: string): McpCancelAction {
    const task = this.tasks.get(id)
    if (!task || FINAL.has(task.status)) return 'none'
    if (task.status === 'na_fila') {
      this.removePending(task)
      this.finish(task, 'cancelada')
      return 'drop-queued'
    }
    return 'interrupt'
  }

  /** Interrupção da conversa (Stop, cancelamento, parar sessão): as tarefas do
   *  turno em andamento são canceladas. As da fila, não — quem tira item da fila
   *  é o renderer, e ele avisa um a um (dropped). */
  onInterrupt(convId: string): void {
    this.endTurn(convId, 'cancelada')
  }

  /** O renderer tirou da fila o item desta tarefa (Stop da conversa, lixeira do item). */
  dropped(id: string, reason: string): void {
    const task = this.tasks.get(id)
    if (!task || task.status !== 'na_fila') return
    this.removePending(task)
    this.finish(task, 'cancelada', { erro: shortError(reason) })
  }

  /** A sessão da conversa foi descartada com um turno de tarefa ainda aberto
   *  (conversa apagada: o "parar sessão" interrompe antes, e aí não sobra nada). */
  onDispose(convId: string, reason = 'A conversa foi fechada no Agent Code.'): void {
    this.endTurn(convId, 'erro', { erro: reason })
  }

  /** Outra sessão assumiu a conversa: o turno de tarefa que estava aberto na
   *  anterior se perdeu e termina em erro (nunca fica `rodando` para sempre). */
  onSessionReplaced(convId: string, reason: string): void {
    this.endTurn(convId, 'erro', { erro: reason })
  }

  /** O renderer não conseguiu nem entregar a tarefa à conversa. */
  fail(id: string, erro: string): void {
    const task = this.tasks.get(id)
    if (!task || FINAL.has(task.status)) return
    this.removePending(task)
    const turn = this.current.get(task.convId)
    if (turn?.includes(id)) this.current.set(task.convId, turn.filter((x) => x !== id))
    this.finish(task, 'erro', { erro: shortError(erro) })
  }

  private isLateTail(convId: string, turnIds: readonly string[] | undefined): boolean {
    if (!turnIds?.length) return false
    const live = this.turnUuid.get(convId)
    const ended = this.endedIds.get(convId) ?? []
    return !turnIds.some((id) => id === live) && turnIds.every((id) => ended.includes(id))
  }

  private markEnded(convId: string, turnIds: readonly string[]): void {
    const list = this.endedIds.get(convId) ?? []
    for (const id of turnIds) if (!list.includes(id)) list.push(id)
    this.endedIds.set(convId, list.slice(-MAX_ENDED_IDS))
  }

  private endTurn(convId: string, status: McpTaskStatus, extra: Partial<McpTask> = {}): void {
    const uuid = this.turnUuid.get(convId)
    if (uuid) {
      this.markEnded(convId, [uuid])
      this.turnUuid.delete(convId)
    }
    const ids = this.current.get(convId) ?? []
    this.current.delete(convId)
    for (const id of ids) {
      const t = this.tasks.get(id)
      if (t && !FINAL.has(t.status)) this.finish(t, status, extra)
    }
  }

  private primary(convId: string): McpTask | undefined {
    const id = this.current.get(convId)?.[0]
    const task = id ? this.tasks.get(id) : undefined
    return task && !FINAL.has(task.status) ? task : undefined
  }

  private removePending(task: McpTask): void {
    const q = this.pending.get(task.convId)
    if (q) this.pending.set(task.convId, q.filter((x) => x !== task.id))
  }

  private finish(task: McpTask, status: McpTaskStatus, extra: Partial<McpTask> = {}): void {
    this.update(task, { status, pergunta: undefined, ...extra })
  }

  private update(task: McpTask, patch: Partial<McpTask>): void {
    Object.assign(task, patch, { updatedAt: this.now() })
    if (patch.pergunta === undefined && 'pergunta' in patch) delete task.pergunta
  }

  private evict(): void {
    if (this.tasks.size <= MAX_TASKS) return
    for (const [id, t] of this.tasks) {
      if (this.tasks.size <= MAX_TASKS) break
      if (FINAL.has(t.status)) this.tasks.delete(id)
    }
  }
}

/** Mensagem curta e legível para o chamador mostrar ao usuário. */
export function shortError(text: string | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return 'A tarefa falhou sem mensagem de erro.'
  return t.length > 400 ? `${t.slice(0, 400)}…` : t
}
