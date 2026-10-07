/**
 * O serviço do "FALA, PO": junta o que já existe (o quadro do projeto, os
 * prints, os prazos, os próximos prompts, a última resposta de cada agente e
 * as tarefas do registro), pergunta ao modelo numa chamada só — sem
 * ferramenta, como o PO de hoje — e guarda a troca por projeto. Só LÊ o
 * quadro: o chat do PO não escreve cartão nem passa pelo PO observador (ele
 * não é uma sessão de agente, então nada do que se diz aqui vira card).
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { boardItemAwaitingBadge, boardItemStatus, boardItemTitle, type BoardItem } from '../../shared/ipc'
import { tempoAtivoMinutos, type HandoffEnvio, type HandoffQueueItem } from '../../shared/handoffTracking'
import type { PoChatMessage, PoChatOption } from '../../shared/poChat'
import type { PoAgentResult } from '../po/poAgentQuery'
import { parsePoChatReply, poChatContextText, poChatPrompt, type PoChatContext, type PoChatConversation } from './poChatModel'
import type { PoChatStore } from './poChatStore'
import { parseVerifyReply, verifyPrompt, verifyTimeoutMs } from './poChatVerify'

export interface PoChatPrintMeta {
  boardItemId: string
  thumbUrl: string
}

export interface PoChatDeps {
  store: PoChatStore
  /** A chave da pasta (a mesma da fila do projeto). */
  key(cwd: string): string
  /** Os cartões do projeto inteiro e o id dele; null com o quadro fora do ar. */
  board(cwd: string): Promise<{ projectId: string; items: BoardItem[] } | null>
  prints(projectId: string): Promise<PoChatPrintMeta[]>
  envios(cwd: string): Promise<HandoffEnvio[]>
  queue(cwd: string): Promise<HandoffQueueItem[]>
  /** As conversas pelo id (as do quadro) e as da pasta. */
  conversations(input: { cwd: string; ids: string[] }): Promise<Array<{ id: string; payload: Record<string, unknown> | null }>>
  tasks(cwd: string): Promise<Array<{ title: string; status: string }>>
  /** A chamada ao modelo (texto vazio = falhou). A conversa escolhe a conta. */
  ask(prompt: string, conversationId: string | undefined): Promise<string>
  /** Tem agente rodando nesta pasta agora? (a verificação só lê, nesse caso) */
  projectBusy?(cwd: string): boolean
  /** A verificação: o modo PO com ferramentas (po/poAgentQuery.ts), ligado no boot. */
  verify?(input: { prompt: string; cwd: string; timeoutMs: number; busy: () => boolean; signal: AbortSignal; conversationId: string | undefined }): Promise<PoAgentResult>
  /** Aplica a correção achada na verificação — o mesmo caminho das escritas do PO. */
  applyCorrection?(cwd: string, option: Extract<PoChatOption, { kind: 'corrigir' }>): Promise<void>
  /**
   * "Mandar fazer": registra o pedido como um plano "Pedido do PO" na fila do
   * projeto (um prompt por conversa, um plano por vez); o despachante solta
   * na hora se o projeto está livre. Devolve o envio registrado.
   */
  registerRequest?(input: {
    cwd: string
    conversationId: string
    conversationTitle: string
    planTitulo: string
    text: string
    /** Entregas ligadas aos cartões citados (`card:<id>`); vazia na conversa nova. */
    cards: Array<{ id: string; title: string }>
  }): Promise<void>
  now?(): number
  newId?(): string
}

/** Teto da resposta rápida: a bolha não fica "pensando" para sempre. */
export const PO_CHAT_ASK_TIMEOUT_MS = 120_000
const MAX_CONVERSATIONS = 12
const QUESTION_MAX = 2_000

const STATUS_LABEL: Record<string, string> = { pending: 'a fazer', in_progress: 'fazendo', completed: 'concluído' }

type StoredMessage = { kind?: unknown; text?: unknown; parentToolUseId?: unknown; ts?: unknown }

/** A última resposta do agente principal da conversa (sem os subagentes) e quando. */
export function lastAgentAnswer(payload: Record<string, unknown> | null): { text: string | null; at: number | null } {
  const messages = Array.isArray(payload?.messages) ? (payload!.messages as StoredMessage[]) : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.kind !== 'assistant-text' || m.parentToolUseId || typeof m.text !== 'string' || !m.text.trim()) continue
    const at = typeof m.ts === 'number' ? m.ts : typeof payload?.updatedAt === 'number' ? (payload.updatedAt as number) : null
    return { text: m.text, at }
  }
  return { text: null, at: null }
}

function deadlines(envios: readonly HandoffEnvio[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const envio of envios) {
    for (const e of envio.entregas) {
      if (!e.boardItemId) continue
      const prazo = e.estimativaPlano !== null ? ` de ${e.estimativaPlano} min` : ' min'
      out.set(e.boardItemId, `prazo: ${tempoAtivoMinutos(e.tempoAtivoMs)}${prazo}${e.atrasada ? ' · atrasada' : ''}`)
    }
  }
  return out
}

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(fallback)
      }
    )
  })
}

export type PoChatAskResult = { ok: true; messages: PoChatMessage[] } | { ok: false; message: string }

export class PoChatService {
  constructor(private readonly deps: PoChatDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private id(): string {
    return this.deps.newId?.() ?? randomUUID()
  }

  history(cwd: string): Promise<PoChatMessage[]> {
    return this.deps.store.read(this.deps.key(cwd))
  }

  /** O que o PO enxerga do projeto agora. Lança só se o quadro está fora do ar. */
  async context(cwd: string): Promise<PoChatContext> {
    const board = await this.deps.board(cwd)
    if (!board) throw new Error('o quadro está indisponível agora (banco ou pasta do projeto fora do ar)')
    const [prints, envios, queue, tasks] = await Promise.all([
      this.deps.prints(board.projectId).catch(() => []),
      this.deps.envios(cwd).catch(() => []),
      this.deps.queue(cwd).catch(() => []),
      this.deps.tasks(cwd).catch(() => [])
    ])
    const thumbs = new Map<string, { count: number; thumbUrl: string }>()
    for (const p of prints) {
      const prev = thumbs.get(p.boardItemId)
      thumbs.set(p.boardItemId, { count: (prev?.count ?? 0) + 1, thumbUrl: prev?.thumbUrl ?? p.thumbUrl })
    }
    const due = deadlines(envios)
    const ids = [...new Set(board.items.map((i) => i.conversationId))]
    const loaded = await this.deps.conversations({ cwd, ids }).catch(() => [])
    const conversations: PoChatConversation[] = loaded
      .map(({ id, payload }) => {
        const last = lastAgentAnswer(payload)
        const title = typeof payload?.title === 'string' && payload.title ? payload.title : 'Conversa'
        return { id, title, lastAnswer: last.text, lastAt: last.at }
      })
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
      .slice(0, MAX_CONVERSATIONS)
    const boardAt = board.items.reduce<number | null>((max, i) => {
      const at = Date.parse(i.updatedAt)
      return Number.isFinite(at) && (max === null || at > max) ? at : max
    }, null)
    return {
      projectName: basename(cwd) || cwd,
      boardAt,
      cards: board.items.map((item) => ({
        id: item.id,
        conversationId: item.conversationId,
        title: boardItemTitle(item),
        status: STATUS_LABEL[boardItemStatus(item)] ?? boardItemStatus(item),
        poReason: item.poReason,
        awaiting: boardItemAwaitingBadge(item)?.label ?? null,
        deadline: due.get(item.id) ?? null,
        prints: thumbs.get(item.id)?.count ?? 0,
        thumbUrl: thumbs.get(item.id)?.thumbUrl ?? null,
        updatedAt: item.updatedAt
      })),
      conversations,
      queue: queue.map((q) => ({
        plan: q.planTitulo,
        label: q.estado === 'rotina' ? `Rotina: ${q.conteudo}` : `Prompt ${q.ordem} de ${q.totalPrompts}`,
        estado: q.estado,
        motivo: q.motivo,
        conversationTitle: q.conversationTitle
      })),
      tasks
    }
  }

  async ask(cwd: string, question: string): Promise<PoChatAskResult> {
    const text = question.trim().slice(0, QUESTION_MAX)
    if (!text) return { ok: false, message: 'Escreva a pergunta.' }
    const key = this.deps.key(cwd)
    const user: PoChatMessage = { id: this.id(), role: 'usuario', text, at: this.now() }
    const history = await this.deps.store.read(key)
    await this.deps.store.append(key, user)
    let ctx: PoChatContext
    try {
      ctx = await this.context(cwd)
    } catch (err) {
      return this.answer(key, { text: 'Não consegui olhar o quadro agora.', error: err instanceof Error ? err.message : String(err) })
    }
    const prompt = poChatPrompt({ ctx, history, question: text, now: this.now() })
    // A conta da conversa mais recente do projeto (como o PO de hoje faz com a dele).
    const raw = await withTimeout(this.deps.ask(prompt, ctx.conversations[0]?.id), PO_CHAT_ASK_TIMEOUT_MS, '')
    if (!raw.trim()) {
      return this.answer(key, { text: 'O PO não respondeu.', error: 'sem resposta do modelo (conta, rede ou demorou demais); tente de novo' })
    }
    const reply = parsePoChatReply(raw, ctx, text)
    return this.answer(key, { text: reply.text, sources: reply.sources, unconfirmed: reply.unconfirmed, options: reply.options })
  }

  private async answer(key: string, body: Omit<PoChatMessage, 'id' | 'role' | 'at'>): Promise<PoChatAskResult> {
    const po: PoChatMessage = { id: this.id(), role: 'po', at: this.now(), ...body }
    return { ok: true, messages: await this.deps.store.append(key, po) }
  }

  /**
   * "Verificar de verdade": confere a resposta rápida no projeto. Falhou,
   * estourou o tempo ou foi cancelada: um aviso, e a resposta rápida fica como
   * estava. Nada no quadro muda aqui — a correção vira botão (`apply`).
   */
  async verify(cwd: string, messageId: string, signal: AbortSignal): Promise<PoChatAskResult> {
    const key = this.deps.key(cwd)
    const quick = (await this.deps.store.read(key)).find((m) => m.id === messageId && m.role === 'po')
    const option = quick?.options?.find((o): o is Extract<PoChatOption, { kind: 'verificar' }> => o.kind === 'verificar')
    if (!quick || !option) return { ok: false, message: 'essa resposta não tem o que verificar' }
    if (!this.deps.verify) return { ok: false, message: 'a verificação não está disponível' }
    let ctx: PoChatContext
    try {
      ctx = await this.context(cwd)
    } catch (err) {
      return this.answer(key, { text: 'A resposta rápida continua como estava.', error: `Não consegui verificar: ${err instanceof Error ? err.message : String(err)}` })
    }
    const busy = (): boolean => this.deps.projectBusy?.(cwd) ?? false
    const prompt = verifyPrompt({ question: option.question, quick, ctx, busy: busy(), contextText: poChatContextText(ctx, this.now()) })
    const source = quick.sources?.find((s) => s.kind === 'conversa' || s.kind === 'card') as { conversationId?: string } | undefined
    const res = await this.deps.verify({ prompt, cwd, timeoutMs: verifyTimeoutMs(option.minutes), busy, signal, conversationId: source?.conversationId ?? ctx.conversations[0]?.id })
    if (res.state !== 'completed' || !res.text.trim()) {
      const why =
        res.state === 'aborted' ? 'A verificação foi cancelada.' : res.state === 'timeout' ? 'A verificação não terminou a tempo.' : `A verificação falhou${res.error ? `: ${res.error}` : '.'}`
      return this.answer(key, { text: 'A resposta rápida continua como estava.', error: why })
    }
    const v = parseVerifyReply(res.text, ctx)
    return this.answer(key, { text: v.text, verified: true, evidence: v.evidence, difference: v.difference, sources: v.sources, options: v.corrections })
  }

  /** A correção do quadro, só no clique (uma vez: depois fica marcada como feita). */
  async apply(cwd: string, messageId: string, index: number): Promise<PoChatAskResult> {
    const key = this.deps.key(cwd)
    const message = (await this.deps.store.read(key)).find((m) => m.id === messageId)
    const option = message?.options?.[index]
    if (!message || !option || option.kind !== 'corrigir') return { ok: false, message: 'correção não encontrada' }
    if (option.applied) return { ok: false, message: 'essa correção já foi aplicada' }
    if (!this.deps.applyCorrection) return { ok: false, message: 'as correções do quadro não estão disponíveis' }
    try {
      await this.deps.applyCorrection(cwd, option)
    } catch (err) {
      return { ok: false, message: `não consegui corrigir o quadro: ${err instanceof Error ? err.message : String(err)}` }
    }
    const options = message.options!.map((o, i) => (i === index ? ({ ...o, applied: true } as PoChatOption) : o))
    return { ok: true, messages: await this.deps.store.replace(key, { ...message, options }) }
  }

  /**
   * "Mandar fazer", no clique de aprovação da prévia: o texto que vai é o da
   * proposta (montado pelo código). Na conversa dona; ou, se ela não está mais
   * neste PC, na conversa nova que a tela acabou de criar (`target`).
   */
  async send(cwd: string, messageId: string, index: number, target?: { conversationId: string; conversationTitle: string }): Promise<PoChatAskResult> {
    const key = this.deps.key(cwd)
    const message = (await this.deps.store.read(key)).find((m) => m.id === messageId)
    const option = message?.options?.[index]
    if (!message || !option || option.kind !== 'mandar') return { ok: false, message: 'pedido não encontrado' }
    if (option.sent) return { ok: false, message: 'esse pedido já foi mandado' }
    if (!this.deps.registerRequest) return { ok: false, message: 'o "mandar fazer" não está disponível' }
    const conversationId = target?.conversationId ?? option.conversationId
    const conversationTitle = target?.conversationTitle ?? option.conversationTitle
    const owner = conversationId === option.conversationId
    const resumo = option.titles.length > 1 ? `${option.titles[0]} (+${option.titles.length - 1})` : (option.titles[0] ?? 'tarefas do quadro')
    try {
      await this.deps.registerRequest({
        cwd,
        conversationId,
        conversationTitle,
        planTitulo: `Pedido do PO: ${resumo}`,
        text: option.text,
        cards: owner ? option.cardIds.map((id, i) => ({ id, title: option.titles[i] ?? id })) : []
      })
    } catch (err) {
      return { ok: false, message: `não consegui mandar: ${err instanceof Error ? err.message : String(err)}` }
    }
    const at = this.now()
    const options = message.options!.map((o, i) => (i === index ? ({ ...o, sent: { conversationId, conversationTitle, at } } as PoChatOption) : o))
    await this.deps.store.replace(key, { ...message, options })
    return this.answer(key, {
      text: `Mandei para '${conversationTitle}'${owner ? '' : ' (conversa nova)'}: entrou na fila do projeto como "Pedido do PO: ${resumo}" — sai assim que for a vez.`,
      options: [{ kind: 'ver-fila' }, { kind: 'abrir-conversa', conversationId, title: conversationTitle }]
    })
  }
}
