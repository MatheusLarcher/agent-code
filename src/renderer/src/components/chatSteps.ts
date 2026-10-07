/**
 * O chat resumido por resposta — PURO (sem React, sem DOM), a regra única de
 * "onde termina uma resposta" para todos os chats: a conversa do PC
 * (MessageList), o monitor e a prévia do Escritório (TurnRows), as conversas do
 * celular e o espelho da Central (centralMirror).
 *
 *   resposta (step)   um texto do agente (narração) + as ferramentas e os
 *                     pensamentos que vieram DEPOIS dele, até o próximo texto.
 *                     Ferramentas antes do 1º texto formam uma resposta sem
 *                     texto. Pensamento solto logo antes de um texto vai com ele
 *                     (é o raciocínio que levou ao texto). A resposta final
 *                     (`answer`) é a resposta do último texto do turno.
 *   linha (msg)       o resto, como sempre: balão do usuário, erro, aviso do
 *                     sistema, troca de conta/modelo. Uma linha dessas fecha a
 *                     resposta aberta — a ordem do tempo nunca muda.
 *
 * Só a trilha principal (`parentToolUseId` nulo): ferramenta de subagente não
 * entra (nem no cartão, nem no resumo). O resumo é o da Central
 * (`summarizeActivity`, sem LLM), calculado por resposta em `stepActivity`.
 *
 * Tipos genéricos: o `UIMessage` do PC e o `ChatMsg` do celular têm os mesmos
 * campos (`kind`, `id`, `text`, `answer`, `name`, `input`, `result`,
 * `parentToolUseId`).
 */
import type { CentralActivity } from '@shared/central'
import { summarizeActivity, type ToolCallLike } from '../central/activitySummary'

/** O que o agrupamento lê de cada mensagem (o resto passa intacto). */
interface Loose {
  kind: string
  id?: string
  text?: string
  answer?: boolean
  name?: string
  input?: unknown
  result?: { isError: boolean; text: string } | null
  parentToolUseId?: string | null
  injected?: boolean
}

/** Uma resposta do agente: texto opcional + o que ele fez depois do texto. */
export interface ChatStep<M> {
  type: 'step'
  /** Id estável da resposta (o da 1ª mensagem dela): guarda o aberto/fechado. */
  id: string
  /** Chave React estável — a mesma da linha do texto, para a resposta final não remontar. */
  key: string
  /** A narração (ou a resposta final); null = resposta sem texto (ferramentas antes do 1º texto). */
  text: M | null
  /** Ferramentas e pensamentos, na ordem em que vieram (o que abre ao clique). */
  items: M[]
  /** Só as ferramentas (para o resumo e a contagem). */
  tools: M[]
  /** O texto é a resposta final (`answer`). */
  final: boolean
  /** A conversa está ocupada e esta é a última resposta do turno: gira e mostra "agora: …". */
  running: boolean
}

/** Uma linha que não é resposta: usuário, erro, aviso, troca de conta/modelo… */
export interface ChatMsgRow<M> {
  type: 'msg'
  key: string
  msg: M
}

export type ChatRowItem<M> = ChatStep<M> | ChatMsgRow<M>

const loose = (m: unknown): Loose => m as Loose

/** Ferramenta da trilha principal (subagente nunca entra). */
const isMainTool = (m: Loose): boolean => m.kind === 'tool-use' && m.parentToolUseId == null
/** O que a regra junta numa resposta (fora o texto). */
const isStepItem = (m: Loose): boolean => isMainTool(m) || m.kind === 'thinking'
/** Linhas que o chat nunca desenha: nem viram linha, nem fecham a resposta. */
const SILENT = new Set(['result', 'tool-result', 'turn-start'])

/** Chave da linha comum (a mesma do `rowKey` do ChatRows). */
function msgKey(m: Loose, idx: number): string {
  switch (m.kind) {
    case 'user':
      return `user:${m.id}`
    case 'assistant-text':
      return `assistant:${m.id}`
    case 'thinking':
      return `thinking:${m.id}`
    case 'tool-use':
      return `tool:${m.id}`
    default:
      return m.id ? `${m.kind}:${m.id}` : `${m.kind}:${idx}`
  }
}

export interface BuildOptions {
  /** A conversa está ocupada agora (a última resposta do turno roda). */
  busy: boolean
}

/**
 * As mensagens em linhas do chat resumido (ver o topo). Não copia nem altera as
 * mensagens: cada linha aponta para as originais (o memo das linhas compara
 * por referência).
 */
export function buildChatRows<M>(messages: readonly M[], opts: BuildOptions): ChatRowItem<M>[] {
  const rows: ChatRowItem<M>[] = []
  let open: ChatStep<M> | null = null
  const close = (): void => {
    open = null
  }
  const startStep = (first: M, idx: number, text: M | null): ChatStep<M> => {
    const f = loose(first)
    const id = f.id ?? `i${idx}`
    const step: ChatStep<M> = {
      type: 'step',
      id,
      key: text ? `assistant:${id}` : `step:${id}`,
      text,
      items: [],
      tools: [],
      final: !!(text && loose(text).answer),
      running: false
    }
    rows.push(step)
    return step
  }
  messages.forEach((m, idx) => {
    const v = loose(m)
    if (!v || typeof v.kind !== 'string' || SILENT.has(v.kind)) return
    if (v.kind === 'tool-use' && !isMainTool(v)) return // subagente: fora do chat
    if (v.kind === 'assistant-text') {
      const cur = open as ChatStep<M> | null
      // Pensamento solto (sem texto nem ferramenta) logo antes: o texto adota a resposta dele.
      if (cur && !cur.text && cur.tools.length === 0) {
        cur.text = m
        cur.key = `assistant:${v.id ?? cur.id}`
        cur.final = !!v.answer
      } else open = startStep(m, idx, m)
      return
    }
    if (isStepItem(v)) {
      // A resposta final fecha o turno: o que vier depois (sem pedido no meio) é outra resposta.
      if ((open as ChatStep<M> | null)?.final) close()
      const step = open ?? (open = startStep(m, idx, null))
      step.items.push(m)
      if (v.kind === 'tool-use') step.tools.push(m)
      return
    }
    close()
    rows.push({ type: 'msg', key: msgKey(v, idx), msg: m })
  })
  if (opts.busy) markRunning(rows)
  return rows
}

/** A última resposta do turno em andamento (nada de usuário depois dela) gira. */
function markRunning<M>(rows: ChatRowItem<M>[]): void {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (r.type === 'step') {
      if (!r.final) r.running = true
      return
    }
    const m = loose(r.msg)
    if (m.kind === 'user' && !m.injected) return
  }
}

/** Ferramentas que o resumo lê (o resultado já vem colado no tool-use). */
function callsOf<M>(tools: readonly M[]): ToolCallLike[] {
  return tools.map((t) => {
    const v = loose(t)
    return { name: v.name ?? '', input: v.input, result: v.result ?? null }
  })
}

/** A linha-resumo de uma resposta — a da Central: "Leu 3 arquivos · editou App.tsx +6 −2 · rodou os testes ✓". */
export function stepActivity<M>(step: Pick<ChatStep<M>, 'tools' | 'running'>, maxChars?: number): CentralActivity {
  return summarizeActivity(callsOf(step.tools), { running: step.running, ...(maxChars ? { maxChars } : {}) })
}

/**
 * O texto da linha quando o resumo vem vazio: só ferramentas de bastidor
 * (plano, tarefas) ou só pensamento. '' = o resumo serve.
 */
export function stepFallback(activity: Pick<CentralActivity, 'segments' | 'now'>, tools: number, thinking: number): string {
  if (activity.segments.length > 0 || activity.now) return ''
  if (tools > 0) return tools === 1 ? 'usou 1 ferramenta' : `usou ${tools} ferramentas`
  return thinking > 0 ? 'pensamento' : ''
}

/**
 * A resposta tem linha-resumo: fez algo ou pensou. Texto ainda sem ferramenta não
 * ganha linha (nem enquanto escreve: o "digitando"/"trabalhando" do chat já diz
 * que roda) — assim a resposta final não perde uma linha vazia ao terminar.
 */
export const stepHasLine = <M>(step: Pick<ChatStep<M>, 'items'>): boolean => step.items.length > 0

/** Quantas linhas mostrar para caber uma mensagem do usuário (busca/mapa): o índice dela nas linhas. */
export function rowIndexOfUser<M>(rows: readonly ChatRowItem<M>[], id: string): number {
  return rows.findIndex((r) => r.type === 'msg' && loose(r.msg).kind === 'user' && loose(r.msg).id === id)
}

/** Memo das linhas: a mesma resposta (mesmas mensagens, mesmo estado) não redesenha. */
export function sameStep<M>(a: ChatStep<M>, b: ChatStep<M>): boolean {
  if (a === b) return true
  if (a.text !== b.text || a.running !== b.running || a.final !== b.final || a.id !== b.id) return false
  if (a.items.length !== b.items.length) return false
  for (let i = 0; i < a.items.length; i++) if (a.items[i] !== b.items[i]) return false
  return true
}
