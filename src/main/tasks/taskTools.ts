import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { StorageError, type LeaseFence, type Task, type TaskStatus } from '../persistence/types'
import type { TaskLedger } from './taskLedger'

/**
 * A porta de entrada do registro de tarefas para o modelo — a primeira peça do
 * item 5 do subprojeto multi-agent ("integração via MCP"). O `TaskLedger` já
 * guardava tarefas com lease, fence e máquina de estados; faltava alguém chamá-lo.
 *
 * Toda resposta é texto em pt-BR legível pelo modelo: uma falha vira uma frase
 * que ele consegue agir em cima (ex.: "fence antigo — reivindique de novo"),
 * nunca um stack trace. As regras duras (transição inválida, fence velho) NÃO
 * são reimplementadas aqui: o repositório é a autoridade, a ferramenta só traduz.
 */

type Text = { content: { type: 'text'; text: string }[] }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })

const LIST_DEFAULT_LIMIT = 30
const LIST_MAX_LIMIT = 100
/** Quantos eventos `task_get` mostra — os mais recentes; o resto é contado. */
const EVENTS_SHOWN = 12

const TASK_STATUSES = ['pending', 'running', 'blocked', 'review', 'done', 'failed', 'cancelled'] as const
const STEP_KINDS = ['analyze', 'implement', 'verify', 'review', 'handoff'] as const
const DELIVERABLE_KINDS = ['diff', 'test_run', 'note', 'file', 'screenshot'] as const
/** Um passo só fecha em estado terminal ou de espera — nunca de volta a pending/running. */
const STEP_FINISH_STATUSES = ['blocked', 'review', 'done', 'failed', 'cancelled'] as const

export interface TaskToolDeps {
  ledger: Pick<
    TaskLedger,
    | 'createTask' | 'claimTask' | 'renewTaskLease' | 'transitionTask' | 'appendStep' | 'finishStep'
    | 'addDeliverable' | 'appendEvent' | 'getTask' | 'listTasks' | 'listSteps' | 'listDeliverables' | 'listEvents'
  >
  conversationId: string
  /** Pasta do projeto da conversa: padrão de `project_cwd` quando o modelo não informa. */
  projectCwd: string
  /** Identidade do chamador nos leases e eventos (ex.: "session:<convId>"). */
  agent: string
  /**
   * Ganchos para a sessão impor o `write_scope` fora do LLM (`writeScopeGuard`):
   * `onClaim` quando esta sessão passa a ser o writer de uma tarefa; `onRelease`
   * quando ela larga a tarefa (review, estado terminal). Opcionais: os testes e
   * um chamador sem gate não precisam deles.
   */
  onClaim?: (task: Task) => void
  onRelease?: (taskId: string) => void
}

/** Estados em que o writer larga a tarefa e o escopo deixa de valer para ele. */
const RELEASING_STATUSES: ReadonlySet<TaskStatus> = new Set(['review', 'done', 'failed', 'cancelled'])

function describeError(error: unknown): string {
  if (error instanceof StorageError) {
    // Os dois códigos que o modelo precisa distinguir para reagir certo.
    if (error.code === 'TASK_FENCE_STALE') {
      return `${error.message} O lease desta tarefa não é mais seu: reivindique de novo com task_claim antes de escrever.`
    }
    if (error.code === 'TASK_INVALID_TRANSITION') {
      return `${error.message} Consulte task_get para ver o estado atual e escolha uma transição válida.`
    }
    return error.message
  }
  if (error instanceof Error) return error.message
  return String(error)
}

/** Mantém a falha dentro da conversa: o modelo corrige o input e tenta de novo. */
async function guard(label: string, work: () => Promise<Text>): Promise<Text> {
  try {
    return await work()
  } catch (error) {
    return text(`${label} falhou: ${describeError(error)}`)
  }
}

/** Fence opcional vindo do modelo. Os dois campos juntos ou nenhum. */
const fenceFields = {
  lease_token: z.string().optional().describe('Token do lease devolvido por task_claim. Obrigatório enquanto a tarefa tiver lease vivo.'),
  fencing_epoch: z.number().int().nonnegative().optional().describe('Epoch do lease devolvido por task_claim, junto do lease_token.')
}

function fenceOf(a: { lease_token?: string; fencing_epoch?: number }): LeaseFence | undefined {
  if (a.lease_token === undefined && a.fencing_epoch === undefined) return undefined
  if (a.lease_token === undefined || a.fencing_epoch === undefined) {
    throw new Error('lease_token e fencing_epoch andam juntos: informe os dois ou nenhum.')
  }
  return { token: a.lease_token, fencingEpoch: a.fencing_epoch }
}

/**
 * Renova o lease depois de uma escrita com fence que deu certo. Um modelo nunca
 * vai lembrar de chamar task_renew_lease no ritmo certo; cada escrita legítima
 * é a prova de vida que mantém a posse. Best-effort: a escrita já aconteceu, e
 * uma renovação recusada (tarefa acabou de fechar) não pode desfazê-la.
 */
async function touch(ledger: TaskToolDeps['ledger'], taskId: string, fence: LeaseFence | undefined): Promise<void> {
  if (!fence) return
  await ledger.renewTaskLease(taskId, fence).catch(() => undefined)
}

function taskLine(task: Task): string {
  const owner = task.ownerAgent ? ` · ${task.ownerAgent}` : ''
  const parent = task.parentTaskId ? ` · filha de ${task.parentTaskId}` : ''
  return `- ${task.id} [${task.status}] ${task.title}${owner}${parent} (tentativas ${task.attempts}/${task.maxAttempts}, revisão ${task.revision})`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- como o próprio SDK tipa a lista de ferramentas.
type AnyTool = SdkMcpToolDefinition<any>
const erase = (definition: unknown): AnyTool => definition as AnyTool

export function buildTaskTools(deps: TaskToolDeps): AnyTool[] {
  return [
    erase(tool(
      'task_create',
      'Registra uma tarefa durável no registro (fila do time de agentes). Use para delegar trabalho ou decompor um pedido em unidades com critério de aceite. A tarefa nasce "pending" e só sai daí quando alguém a reivindica com task_claim.',
      {
        title: z.string().min(1).describe('Título curto.'),
        goal: z.string().min(1).describe('O que precisa ficar pronto, em uma ou duas frases.'),
        acceptance: z.array(z.string()).optional().describe('Critérios verificáveis de aceite (ex.: "testes passam", "typecheck limpo").'),
        project_cwd: z.string().optional().describe('Pasta do projeto. Padrão: a pasta desta conversa.'),
        write_scope_allow: z.array(z.string()).optional().describe('Globs (relativos ao projeto) que o executor PODE alterar.'),
        write_scope_deny: z.array(z.string()).optional().describe('Globs que o executor NÃO pode alterar, mesmo dentro do allow.'),
        parent_task_id: z.string().optional().describe('Id da tarefa-mãe, quando esta é uma subtarefa.'),
        max_attempts: z.number().int().positive().optional().describe('Quantas vezes pode voltar a pending depois de falhar (padrão 3).')
      },
      async (a) =>
        guard('task_create', async () => {
          const task = await deps.ledger.createTask({
            conversationId: deps.conversationId,
            projectCwd: a.project_cwd ?? deps.projectCwd,
            title: a.title,
            goal: a.goal,
            acceptance: a.acceptance,
            writeScope: a.write_scope_allow || a.write_scope_deny
              ? { allow: a.write_scope_allow ?? [], deny: a.write_scope_deny ?? [] }
              : undefined,
            parentTaskId: a.parent_task_id ?? null,
            maxAttempts: a.max_attempts
          })
          return text(`Tarefa criada: ${task.id} [${task.status}] ${task.title}. Para executá-la, reivindique com task_claim.`)
        })
    )),

    erase(tool(
      'task_list',
      'Lista tarefas do registro com id, estado, título, dono e tentativas. Sem filtro, mostra as não terminadas (pending/running/blocked/review).',
      {
        status: z.array(z.enum(TASK_STATUSES)).optional().describe('Estados a incluir. Padrão: pending, running, blocked, review.'),
        project_cwd: z.string().optional().describe('Restringe a um projeto. Padrão: todos.'),
        parent_task_id: z.string().optional().describe('Só as subtarefas desta tarefa.'),
        limit: z.number().int().positive().optional().describe(`Máximo de itens (padrão ${LIST_DEFAULT_LIMIT}, teto ${LIST_MAX_LIMIT}).`)
      },
      async (a) =>
        guard('task_list', async () => {
          const limit = Math.min(a.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT)
          const status: TaskStatus[] = a.status ?? ['pending', 'running', 'blocked', 'review']
          const tasks = await deps.ledger.listTasks({
            status,
            projectCwd: a.project_cwd,
            parentTaskId: a.parent_task_id,
            // +1 para saber se há mais sem trazer tudo.
            limit: limit + 1
          })
          if (!tasks.length) return text('Nenhuma tarefa nesses estados.')
          const shown = tasks.slice(0, limit)
          const lines = shown.map(taskLine)
          if (tasks.length > shown.length) lines.push(`… há mais tarefas; refine por status/projeto ou aumente "limit".`)
          return text(lines.join('\n'))
        })
    )),

    erase(tool(
      'task_get',
      'Detalha uma tarefa: objetivo, critérios de aceite, escopo de escrita, lease atual, passos, entregáveis e os eventos mais recentes.',
      { task_id: z.string().describe('Id da tarefa.') },
      async ({ task_id }) =>
        guard('task_get', async () => {
          const task = await deps.ledger.getTask(task_id)
          if (!task) return text(`Não existe tarefa ${task_id}.`)
          const [steps, deliverables, events] = await Promise.all([
            deps.ledger.listSteps(task.id),
            deps.ledger.listDeliverables(task.id),
            deps.ledger.listEvents(task.id)
          ])
          const lines: string[] = [
            `${task.id} [${task.status}] ${task.title}`,
            `Objetivo: ${task.goal}`,
            `Projeto: ${task.projectCwd}`,
            `Aceite: ${task.acceptance.length ? task.acceptance.map((item) => `\n  - ${item}`).join('') : '(nenhum declarado)'}`,
            `Escopo de escrita: allow=${JSON.stringify(task.writeScope.allow)} deny=${JSON.stringify(task.writeScope.deny)}`,
            `Dono: ${task.ownerAgent ?? '—'} · tentativas ${task.attempts}/${task.maxAttempts} · revisão ${task.revision}`,
            task.leaseToken
              ? `Lease: vivo até ${task.leaseExpiresAt} (epoch ${task.fencingEpoch}). Escritas exigem o fence de quem reivindicou.`
              : `Lease: nenhum (epoch ${task.fencingEpoch}).`
          ]
          if (task.parentTaskId) lines.push(`Tarefa-mãe: ${task.parentTaskId}`)
          lines.push(
            steps.length
              ? `Passos:${steps.map((step) => `\n  - ${step.id} #${step.seq} ${step.kind} [${step.status}]${step.agent ? ` · ${step.agent}` : ''}${step.error ? ` · erro: ${JSON.stringify(step.error)}` : ''}`).join('')}`
              : 'Passos: nenhum.'
          )
          lines.push(
            deliverables.length
              ? `Entregáveis:${deliverables.map((item) => `\n  - ${item.id} ${item.kind}${item.verified ? ' ✓' : ''}: ${item.summary}${item.payloadPath ? ` (${item.payloadPath})` : ''}`).join('')}`
              : 'Entregáveis: nenhum.'
          )
          const recent = events.slice(-EVENTS_SHOWN)
          const omitted = events.length - recent.length
          lines.push(
            `Eventos${omitted > 0 ? ` (${omitted} anteriores omitidos)` : ''}:${recent.map((event) => `\n  - ${event.at} ${event.kind}${Object.keys(event.data).length ? ` ${JSON.stringify(event.data)}` : ''}`).join('')}`
          )
          return text(lines.join('\n'))
        })
    )),

    erase(tool(
      'task_claim',
      'Reivindica UMA tarefa "pending" sem lease vivo e devolve o LEASE (lease_token + fencing_epoch). Por padrão só do projeto desta conversa; informe task_id para pegar uma tarefa específica (é o que um subagente delegado deve fazer). Guarde os dois valores: toda escrita nesta tarefa exige esse fence, e outro agente NÃO consegue reivindicar a mesma tarefa enquanto o lease viver. A tarefa continua "pending" até você chamar task_transition para "running". Se a tarefa tem write_scope, Write/Edit fora dele passam a ser recusados nesta sessão.',
      {
        task_id: z.string().optional().describe('Id de uma tarefa específica. Sem ele, a pending mais antiga do projeto.'),
        project_cwd: z.string().optional().describe('Projeto de onde reivindicar. Padrão: a pasta desta conversa.'),
        any_project: z.boolean().optional().describe('true para aceitar tarefa de qualquer projeto (raro; só um supervisor global).'),
        agent: z.string().optional().describe('Identidade de quem executa. Padrão: esta sessão.')
      },
      async (a) =>
        guard('task_claim', async () => {
          const claim = await deps.ledger.claimTask(a.agent ?? deps.agent, {
            taskId: a.task_id,
            projectCwd: a.any_project || a.task_id ? undefined : a.project_cwd ?? deps.projectCwd
          })
          if (!claim) {
            return text(
              a.task_id
                ? `A tarefa ${a.task_id} não está disponível: não existe, não está pending, esgotou as tentativas ou outro agente tem o lease. Veja task_get.`
                : 'Nenhuma tarefa pending disponível para reivindicar neste projeto.'
            )
          }
          deps.onClaim?.(claim.task)
          return text(
            [
              `Tarefa reivindicada: ${claim.task.id} [${claim.task.status}] ${claim.task.title}`,
              `lease_token: ${claim.token}`,
              `fencing_epoch: ${claim.fencingEpoch}`,
              `Lease expira em ${claim.expiresAt}; renove com task_renew_lease se o trabalho for longo.`,
              `Próximo passo: task_transition de "pending" para "running" com este fence.`
            ].join('\n')
          )
        })
    )),

    erase(tool(
      'task_renew_lease',
      'Renova o lease de uma tarefa que você reivindicou, para um trabalho longo não perder a posse. Exige o fence atual.',
      {
        task_id: z.string().describe('Id da tarefa.'),
        lease_token: z.string().describe('Token do lease atual.'),
        fencing_epoch: z.number().int().nonnegative().describe('Epoch do lease atual.')
      },
      async (a) =>
        guard('task_renew_lease', async () => {
          const claim = await deps.ledger.renewTaskLease(a.task_id, { token: a.lease_token, fencingEpoch: a.fencing_epoch })
          return text(`Lease renovado até ${claim.expiresAt} (epoch ${claim.fencingEpoch}).`)
        })
    )),

    erase(tool(
      'task_transition',
      'Muda o estado de uma tarefa. Transições válidas: pending→running; running→blocked|review|failed|cancelled; blocked→running|cancelled; review→done|running|failed; failed→pending (retomada, só se ainda houver tentativas). Enquanto houver lease vivo, exige o fence de quem reivindicou.',
      {
        task_id: z.string().describe('Id da tarefa.'),
        from: z.enum(TASK_STATUSES).describe('Estado atual esperado. Se não bater, a transição é recusada.'),
        to: z.enum(TASK_STATUSES).describe('Estado de destino.'),
        reason: z.string().optional().describe('Por quê — vai para o histórico de eventos.'),
        ...fenceFields
      },
      async (a) =>
        guard('task_transition', async () => {
          const fence = fenceOf(a)
          const task = await deps.ledger.transitionTask(a.task_id, a.from, a.to, fence, {
            agent: deps.agent,
            reason: a.reason
          })
          if (RELEASING_STATUSES.has(task.status)) deps.onRelease?.(task.id)
          else await touch(deps.ledger, task.id, fence)
          return text(`Tarefa ${task.id} agora está [${task.status}] (revisão ${task.revision}).`)
        })
    )),

    erase(tool(
      'task_step_start',
      'Abre um passo dentro de uma tarefa (analyze, implement, verify, review, handoff). Devolve o step_id para fechar depois com task_step_finish.',
      {
        task_id: z.string().describe('Id da tarefa.'),
        kind: z.enum(STEP_KINDS).describe('Tipo do passo.'),
        ...fenceFields
      },
      async (a) =>
        guard('task_step_start', async () => {
          const fence = fenceOf(a)
          const step = await deps.ledger.appendStep({
            taskId: a.task_id,
            kind: a.kind,
            agent: deps.agent,
            sdkSessionId: deps.conversationId,
            fence
          })
          await touch(deps.ledger, a.task_id, fence)
          return text(`Passo aberto: ${step.id} (#${step.seq} ${step.kind}). Feche com task_step_finish.`)
        })
    )),

    erase(tool(
      'task_step_finish',
      'Fecha um passo com o resultado. Em "failed", informe o erro para o próximo executor não repetir o mesmo caminho.',
      {
        step_id: z.string().describe('Id do passo (de task_step_start).'),
        status: z.enum(STEP_FINISH_STATUSES).describe('Resultado do passo.'),
        error: z.record(z.string(), z.unknown()).optional().describe('Detalhes do erro quando status = failed.'),
        ...fenceFields
      },
      async (a) =>
        guard('task_step_finish', async () => {
          const fence = fenceOf(a)
          const step = await deps.ledger.finishStep({
            stepId: a.step_id,
            status: a.status,
            error: a.error ?? null,
            fence
          })
          await touch(deps.ledger, step.taskId, fence)
          return text(`Passo ${step.id} fechado como [${step.status}].`)
        })
    )),

    erase(tool(
      'task_deliverable_add',
      'Registra um entregável (diff, test_run, note, file, screenshot) — a EVIDÊNCIA que o supervisor vai avaliar. Sem entregável, "done" é só uma afirmação.',
      {
        task_id: z.string().describe('Id da tarefa.'),
        kind: z.enum(DELIVERABLE_KINDS).describe('Tipo do entregável.'),
        summary: z.string().min(1).describe('O que é e o que prova.'),
        payload_path: z.string().optional().describe('Caminho do artefato em disco, quando houver.'),
        step_id: z.string().optional().describe('Passo que o produziu.'),
        ...fenceFields
      },
      async (a) =>
        guard('task_deliverable_add', async () => {
          const fence = fenceOf(a)
          const item = await deps.ledger.addDeliverable({
            taskId: a.task_id,
            stepId: a.step_id ?? null,
            kind: a.kind,
            summary: a.summary,
            payloadPath: a.payload_path ?? null,
            fence
          })
          await touch(deps.ledger, a.task_id, fence)
          return text(`Entregável registrado: ${item.id} (${item.kind}).`)
        })
    )),

    erase(tool(
      'task_event',
      'Anota um evento livre no histórico da tarefa (decisão, bloqueio encontrado, pedido de ajuda). Não muda estado; é só trilha.',
      {
        task_id: z.string().describe('Id da tarefa.'),
        kind: z.string().min(1).describe('Nome curto do evento (ex.: "decision", "blocker", "handoff").'),
        data: z.record(z.string(), z.unknown()).optional().describe('Detalhes estruturados.'),
        step_id: z.string().optional().describe('Passo relacionado, se houver.')
      },
      async (a) =>
        guard('task_event', async () => {
          const event = await deps.ledger.appendEvent({
            taskId: a.task_id,
            stepId: a.step_id ?? null,
            kind: a.kind,
            data: { ...(a.data ?? {}), agent: deps.agent }
          })
          return text(`Evento ${event.kind} registrado em ${event.at}.`)
        })
    ))
  ]
}

export function createTaskMcpServer(deps: TaskToolDeps): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({ name: 'tasks', version: '1.0.0', tools: buildTaskTools(deps) })
}
