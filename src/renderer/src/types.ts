import type { BackgroundTask, ChatEvent, QueuedAfterInterrupt } from '@shared/ipc'
import type { CentralState } from '@shared/central'
import type { BubbleMedia, DraftMedia } from './inlineMedia/inlineAttachments'

/** A user message, rendered on the right side of the chat. */
export type UserMessage = {
  kind: 'user'
  id: string
  text: string
  /** Data-URL thumbnails of any attached images (for display only). */
  images?: string[]
  /** Non-image file attachments shown as cards in the bubble (display only). */
  files?: { name: string; size: number }[]
  /** Anexos postos no meio do texto: a posição N-1 diz onde está o `{{midia:N}}`
   *  de `text` (imagem i de `images` ou arquivo i de `files`). Ausente = bolha antiga. */
  media?: BubbleMedia[]
  /** Set when this message's turn failed (LLM/session error). The message stays
   *  in the chat showing this error and a "Tentar de novo" button, so a typed
   *  message is never lost even when the model errors. */
  error?: string
  /** Set when the user manually canceled this message's turn — the chat shows a
   *  small "cancelada" note and the model is told to disregard it. */
  canceled?: boolean
  /** Enviada pelo botão "agora" da fila: entrou no turno em andamento como
   *  ajuste (não abriu um turno novo). */
  injected?: boolean
}

/** Anything the message list can render (agent events + user messages). */
export type UIMessage = (ChatEvent | UserMessage) & {
  result?: { isError: boolean; text: string }
  /** Set on the final assistant text of a turn (the actual answer, shown in full font). */
  answer?: boolean
  /** Epoch ms the turn finished — stamped on the answer so the chat can show
   *  when (and how long ago) that task ran. */
  ts?: number
}

/** Per-session token/cost accounting shown in the chat header. */
export interface TokenTotals {
  context: number
  output: number
  cost: number
  lastOutput?: number
  lastCost?: number
}

/** O turno em voo de uma conversa, gravado com ela (turnInFlight.ts): o app que
 *  fecha no meio dele o retoma "de onde parou" no próximo boot. */
export interface TurnInFlight {
  /** A bolha do usuário que abriu o turno. */
  msgId: string
  /** Epoch ms em que o turno começou. */
  at: number
  /** Tarefa do MCP de entrada: essa nunca é reenviada pelo app (regra 2). */
  mcpTaskId?: string
  /** O envio ao main já saiu. Sem isto o app fechou antes (ex.: na espera da fila). */
  sent?: true
  /** `installationId` do PC que rodava o turno: só ele o retoma (o banco é dividido). */
  device?: string
}

export interface TurnRecovery {
  id: string
  reason: 'limit' | 'transient'
  scheduledAt: number
  attempt: number
  maxAttempts: number
  errorText: string
  messageId: string | null
}

/** One task in the agent's plan, fed by either the legacy TodoWrite tool or the
 *  modern TaskCreate/TaskUpdate pair (the one actually used in practice — see
 *  App.tsx). `id` is only set/used on the TaskCreate/TaskUpdate path, to
 *  correlate a later TaskUpdate call back to the right item; TodoWrite always
 *  replaces the whole list wholesale and never needs it. */
export interface TodoItem {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

/** The agent's current task plan for a conversation — replaced/patched each
 *  time the agent tracks progress again, so it reads as one live checklist
 *  instead of a new card per call. `active` goes false when the turn ends
 *  (result/error), collapsing the card to a summary — it stays visible either
 *  way, it just stops showing the spinner. */
export interface TodoPlan {
  items: TodoItem[]
  active: boolean
}

/** A single conversation, grouped by its project folder (`cwd`) in the sidebar. */
export interface Conversation {
  id: string
  title: string
  /** De onde veio o título: 'auto' = recuo com o começo da 1ª mensagem (o LLM
   *  ainda pode trocar), 'llm' = nome curto do LLM, 'user' = renomeada pelo
   *  usuário — trava: nada automático mexe mais nele. Ausente = título padrão
   *  ou conversa anterior a este campo. Ver conversationTitle.ts. */
  titleSource?: 'auto' | 'llm' | 'user'
  /** Project folder the agent runs in. */
  cwd: string
  model: string
  /** The concrete model the last turn actually ran on, when `model` is the
   *  AUTO_MODEL sentinel. `model` must KEEP the sentinel — it is what the
   *  selector shows and what makes the next turn ask again — so the real id
   *  lives here, for the things that need it (the context-usage denominator). */
  autoModel?: string
  /** Reasoning effort for the model (low / medium / high / xhigh / max), or the
   *  AUTO_EFFORT sentinel — independent from AUTO_MODEL. */
  effort?: string
  /** O esforço concreto que o decisor escolheu no último turno, quando `effort`
   *  é o AUTO_EFFORT (mesmo papel do `autoModel`): `effort` continua `auto`, e
   *  este campo só alimenta o "Auto · Alto" do seletor. Na conversa do Agent
   *  Manager é o esforço com que a sessão dele subiu. */
  autoEffort?: string
  /** Marcador one-shot da separação dos Automáticos (EFFORT_SPLIT_FIELD em
   *  src/shared/autoEffort.ts): ausente = registro gravado antes dela. */
  effortSplit?: true
  /** Per-conversation "modo rápido" — Opus at up to ~2.5x output speed for a
   *  higher per-token price. Only applies to models in FAST_MODE_MODELS. */
  fastMode?: boolean
  /** SDK session id captured from the agent, used to resume the conversation later. */
  sdkSessionId: string | null
  /** Conta Claude (várias contas) em que a conversa roda; gravada com ela. */
  claudeAccountId?: string
  /** Unsent composer text for this conversation (draft). Kept across conversation
   *  switches and app restarts so a half-typed message is never lost. */
  draft?: string
  /** Anexos do rascunho, na ordem dos `{{midia:N}}` de `draft`. */
  draftMedia?: DraftMedia[]
  /** A failed turn waiting to resume; persisted so app restarts restore its timer. */
  recovery?: TurnRecovery
  /** Turno em andamento (marcado ao enviar, limpo no terminal) — ver turnInFlight.ts. */
  turnInFlight?: TurnInFlight
  /** The agent's current task plan, if it has tracked progress at least once
   *  in this conversation. Rendered as a fixed card above the composer. */
  todoPlan?: TodoPlan
  /** Replace-semantics snapshot of work still running outside the foreground turn. */
  backgroundTasks?: BackgroundTask[]
  /** Messages reported by interrupt() that will still execute after Stop. */
  queuedAfterInterrupt?: QueuedAfterInterrupt[]
  messages: UIMessage[]
  tokens: TokenTotals
  createdAt: number
  updatedAt: number
  /** 'planning': esta conversa É a Tela de Planejamento — a sessão sobe como o
   *  Agent Manager do plano `planningSlug` (StartAgentOptions.planning) e o
   *  modelo dela é decidido no main, não pelo seletor.
   *  'central': esta conversa É a Central (id fixo CENTRAL_ID, sem pasta) — nunca
   *  sobe sessão de agente; cada mensagem dela vai para a conversa do assunto.
   *  Ausente = conversa normal. */
  mode?: 'planning' | 'central'
  /** O que a Central mostra (pedidos, respostas espelhadas, perguntas). Só com
   *  mode 'central'; nunca guarda bytes de anexo (só nomes). */
  central?: CentralState
  /** Slug do plano do projeto `cwd` (a pasta real, na pasta de dados do app,
   *  o main resolve). Só com mode 'planning'. */
  planningSlug?: string
  /** Conversa de implementação nascida do handoff do plano <handoffSlug> do projeto `cwd`:
   *  a sessão sobe com StartAgentOptions.handoff. É uma conversa normal (sem `mode`). */
  handoffSlug?: string
  /** De onde veio a conversa de implementação: o plano (o cabeçalho mostra
   *  "Plano: <titulo>" e reabre a Tela dele) e os arquivos de _handoff/ que ela
   *  recebeu, na ordem. Vai no payload da conversa, como os outros campos. */
  handoffPlan?: { projectCwd: string; slug: string; titulo: string; prompts: string[] }
}

export const DEFAULT_TITLE = 'Nova conversa'
